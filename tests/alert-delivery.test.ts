import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PGM_DATA_DIR = mkdtempSync(join(tmpdir(), 'pgm-alert-delivery-test-'));
process.env.PGM_SECRET_KEY = 'test-key-for-alert-delivery';
const store = await import('../src/lib/server/store.ts');
const { encrypt } = await import('../src/lib/server/crypto.ts');
// Channels as an earlier version stored them, before anything reads them.
const legacy = (id: string, kind: string, secrets: Record<string, string>, config: Record<string, string> = {}) =>
	store
		.sqlite()
		.prepare('INSERT INTO alert_channels (id, name, kind, config, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
		.run(id, id, kind, JSON.stringify(config), encrypt(JSON.stringify(secrets), `alert-channel:${id}`), '2026-01-01', '2026-01-01');
legacy('old-slack', 'slack', { url: 'https://hooks.slack.com/services/T/B/x' });
legacy('old-mattermost', 'slack', { url: 'https://chat.lan/hooks/abc' });
legacy('old-ntfy', 'ntfy', { token: 'tk' }, { server: 'https://ntfy.sh', topic: 't' });

const alerts = await import('../src/lib/server/alerts/store.ts');
const { parseChannelInput } = await import('../src/lib/server/alerts/input.ts');
const { broadcast, sendTo } = await import('../src/lib/server/alerts/dispatch.ts');
import type { Notification } from '../src/lib/server/alerts/notify.ts';
import { DEFAULT_CHANNEL_OPTIONS } from '../src/lib/alerts.ts';

test('existing channels are migrated: Slack format by host, explicit options', () => {
	const byId = Object.fromEntries(alerts.listChannels().map((c) => [c.id, c]));
	assert.equal(byId['old-slack'].config.format, 'blocks');
	assert.equal(byId['old-mattermost'].config.format, 'attachments');
	assert.equal(byId['old-ntfy'].config.topic, 't');
	assert.equal(byId['old-ntfy'].options.maxPerHour, 30);
	const raw = store.sqlite().prepare(`SELECT options FROM alert_channels WHERE id = 'old-ntfy'`).get() as { options: string };
	assert.equal(JSON.parse(raw.options).dedupeMinutes, 5);
	assert.equal(alerts.channelWithSecrets('old-ntfy')!.secrets.token, 'tk', 'secrets survive');
	for (const id of ['old-slack', 'old-mattermost', 'old-ntfy']) alerts.deleteChannel(id);
});

test('new channel kinds: field types are validated, hidden fields dropped, secrets never returned', () => {
	assert.throws(() => parseChannelInput({ kind: 'email', config: { host: 'smtp', from: 'a@x.io', to: 'a@x.io, nope' } }), /not an email address: nope/);
	assert.throws(() => parseChannelInput({ kind: 'email', config: { port: '5x' } }), /Port must be a number/);
	assert.throws(() => parseChannelInput({ kind: 'email', config: { security: 'ssl3' } }), /choose one of the options/);
	assert.throws(() => parseChannelInput({ kind: 'matrix', config: { homeserver: 'ftp://hs' } }), /http/);
	assert.throws(() => parseChannelInput({ kind: 'telegram', config: {}, options: { quietHours: { timezone: 'Mars/Base' } } }), /Unknown time zone/);

	const ha = parseChannelInput({ kind: 'homeassistant', name: 'HA', config: { url: 'http://ha.lan:8123', mode: 'service', service: 'mobile_app_x' }, secrets: { token: 'llat-secret', webhookId: 'hook-secret' } });
	const { config, secrets } = alerts.resolveChannelInput(ha);
	assert.deepEqual(Object.keys(secrets), ['token'], 'the webhook id does not apply in service mode');
	assert.deepEqual(alerts.missingFields('homeassistant', config, secrets), []);
	assert.deepEqual(alerts.missingFields('homeassistant', { url: 'x' }, {}), ['Webhook ID'], 'webhook mode is the default');
	const c = alerts.createChannel(ha);
	assert.ok(!JSON.stringify(c).includes('llat-secret'));
	assert.equal(c.secrets.token, '••••••');

	const email = alerts.resolveChannelInput(parseChannelInput({ kind: 'email', config: { host: 'smtp.lan', from: 'a@x.io', to: 'b@x.io' } }));
	assert.equal(email.config.security, 'starttls', 'select fields get their default');
	assert.equal(email.config.verifyCert, 'verify');
	alerts.deleteChannel(c.id);
});

test('options round-trip, and an update without options keeps them', () => {
	const c = alerts.createChannel(
		parseChannelInput({
			kind: 'telegram',
			name: 'TG',
			config: { chatId: '1' },
			secrets: { botToken: '1:abc' },
			options: { minSeverity: 'critical', ruleKinds: ['unreachable'], quietHours: { enabled: true, start: '23:00', end: '06:00', timezone: 'Europe/Berlin' }, maxPerHour: 5 }
		})
	);
	assert.equal(c.options.minSeverity, 'critical');
	assert.deepEqual(c.options.ruleKinds, ['unreachable']);
	assert.equal(c.options.quietHours.timezone, 'Europe/Berlin');
	const toggled = alerts.updateChannel(c.id, parseChannelInput({ kind: 'telegram', name: 'TG', enabled: false, config: { chatId: '1' }, secrets: {} }, c.options))!;
	assert.equal(toggled.enabled, false);
	assert.deepEqual(toggled.options, c.options);
	assert.equal(alerts.channelWithSecrets(c.id)!.secrets.botToken, '1:abc');
	alerts.deleteChannel(c.id);
});

const note = (over: Partial<Notification> = {}): Notification => ({
	event: 'fired',
	severity: 'warning',
	title: 'Long-running query',
	message: 'Query running for 20 min',
	connection: { id: 'c1', name: 'app', engine: 'postgres' },
	rule: { id: 'r1', kind: 'long_query' },
	value: null,
	since: null,
	at: new Date().toISOString(),
	url: null,
	...over
});

function fakeFetch(fail?: (url: string) => string | null) {
	const calls: string[] = [];
	const f = (async (url: string) => {
		calls.push(url);
		const err = fail?.(url);
		return err ? new Response(err, { status: 400 }) : new Response('ok');
	}) as unknown as typeof fetch;
	return { calls, deps: { fetch: f, timeoutMs: 1000 } };
}

test('broadcast routes per channel, logs every attempt, de-duplicates and rate-limits', async () => {
	const all = alerts.createChannel(parseChannelInput({ kind: 'webhook', name: 'All', secrets: { url: 'https://hook.example/all' }, options: { dedupeMinutes: 10, maxPerHour: 2 } }));
	const crit = alerts.createChannel(parseChannelInput({ kind: 'discord', name: 'Critical only', secrets: { url: 'https://discord.example/api/webhooks/1/x' }, options: { minSeverity: 'critical' } }));
	const broken = alerts.createChannel(parseChannelInput({ kind: 'slack', name: 'Broken', secrets: { url: 'https://hooks.slack.example/bad' }, options: { maxPerHour: 0, dedupeMinutes: 0 } }));
	const off = alerts.createChannel(parseChannelInput({ kind: 'ntfy', name: 'Off', enabled: false, config: { server: 'https://ntfy.example', topic: 't' } }));
	const f = fakeFetch((url) => (url.includes('/bad') ? 'invalid_token' : null));

	let r = await broadcast(note(), 1, f.deps);
	assert.equal(r.delivered, 1);
	assert.equal(r.suppressed, 1);
	assert.deepEqual(r.errors, ['Broken: HTTP 400: invalid_token']);
	assert.deepEqual(f.calls.sort(), ['https://hook.example/all', 'https://hooks.slack.example/bad']);

	// The same alert event again: "All" drops it as a duplicate.
	r = await broadcast(note(), 2, f.deps);
	assert.equal(r.delivered, 0);
	// A different event of the same alert passes; then the hourly limit (2) is reached.
	r = await broadcast(note({ event: 'resolved' }), 3, f.deps);
	assert.equal(r.delivered, 1);
	r = await broadcast(note({ rule: { id: 'r2', kind: 'connections' } }), 4, f.deps);
	assert.equal(r.delivered, 0);
	// A new critical alert skips the limit, and reaches the critical-only channel too.
	r = await broadcast(note({ severity: 'critical', rule: { id: 'r3', kind: 'unreachable' } }), 5, f.deps);
	assert.equal(r.delivered, 2);

	const log = alerts.listDeliveries({ limit: 100 });
	const forAll = log.filter((d) => d.channelId === all.id).map((d) => `${d.event}:${d.status}:${d.detail ?? ''}`);
	assert.deepEqual(forAll.reverse(), [
		'fired:sent:',
		'fired:suppressed:Duplicate within 10 min',
		'resolved:sent:',
		'fired:suppressed:Rate limit (2 per hour)',
		'fired:sent:'
	]);
	const critLog = log.filter((d) => d.channelId === crit.id);
	assert.equal(critLog.at(-1)!.detail, 'Not routed: below critical');
	assert.equal(critLog[0].status, 'sent');
	assert.ok(!log.some((d) => d.channelId === off.id), 'disabled channels are skipped');
	const failed = log.filter((d) => d.channelId === broken.id && d.status === 'failed').at(-1)!;
	assert.equal(failed.detail, 'HTTP 400: invalid_token');
	assert.equal(failed.eventId, 1);
	assert.equal(typeof failed.durationMs, 'number');
	assert.equal(alerts.getChannel(broken.id)!.lastError, 'HTTP 400: invalid_token');
	assert.equal(alerts.listDeliveries({ channelId: crit.id }).length, 5);
	assert.equal(alerts.listDeliveries({ limit: 2, before: log[1].id }).length, 2);
	for (const c of [all, crit, broken, off]) alerts.deleteChannel(c.id);
});

test('a test send ignores routing and limits, and an unsaved channel is logged without an id', async () => {
	const f = fakeFetch(() => 'nope');
	const r = await sendTo(
		{ channel: { id: null, name: 'Draft', kind: 'webhook', config: {}, options: { ...DEFAULT_CHANNEL_OPTIONS, minSeverity: 'critical' } }, secrets: { url: 'https://hook.example/t' } },
		note({ event: 'test', rule: null, connection: null }),
		{ deps: f.deps }
	);
	assert.deepEqual(r, { status: 'failed', detail: 'HTTP 400: nope' });
	const last = alerts.listDeliveries({ limit: 1 })[0];
	assert.equal(last.channelId, null);
	assert.equal(last.channelName, 'Draft');
	assert.equal(last.event, 'test');
});
