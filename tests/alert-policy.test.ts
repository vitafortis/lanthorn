import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, dedupeKey, inQuietHours, minutesOfDay, normalizeOptions, routeMatches } from '../src/lib/server/alerts/policy.ts';
import { DEFAULT_CHANNEL_OPTIONS, type ChannelOptions } from '../src/lib/alerts.ts';
import type { Notification } from '../src/lib/server/alerts/notify.ts';

const n = (over: Partial<Notification> = {}): Notification => ({
	event: 'fired',
	severity: 'warning',
	title: 'Long-running query',
	message: 'm',
	connection: { id: 'c1', name: 'app', engine: 'postgres' },
	rule: { id: 'r1', kind: 'long_query' },
	value: null,
	since: null,
	at: '2026-10-09T10:00:00.000Z',
	url: null,
	...over
});
const opts = (over: Partial<ChannelOptions> = {}): ChannelOptions => ({ ...DEFAULT_CHANNEL_OPTIONS, maxPerHour: 0, dedupeMinutes: 0, ...over });
const none = { lastHour: 0, lastSameAt: null };
const at = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00.000Z`);

test('normalizeOptions fills defaults, drops junk and clamps numbers', () => {
	assert.deepEqual(normalizeOptions(undefined), DEFAULT_CHANNEL_OPTIONS);
	const o = normalizeOptions({
		minSeverity: 'critical',
		ruleKinds: ['unreachable', 'nope', 'unreachable'],
		connectionIds: ['a', 'gone', 3],
		quietHours: { enabled: true, start: '25:00', end: '06:30', timezone: 'Not/AZone', allowCritical: false },
		maxPerHour: -5,
		dedupeMinutes: '15'
	}, (id) => id === 'a');
	assert.equal(o.minSeverity, 'critical');
	assert.deepEqual(o.ruleKinds, ['unreachable']);
	assert.deepEqual(o.connectionIds, ['a']);
	assert.deepEqual(o.quietHours, { enabled: true, start: '22:00', end: '06:30', timezone: '', allowCritical: false });
	assert.equal(o.maxPerHour, 0);
	assert.equal(o.dedupeMinutes, 15);
});

test('routing: severity, rule kinds, connections and event types', () => {
	assert.equal(routeMatches(opts(), n()), null);
	assert.match(routeMatches(opts({ minSeverity: 'critical' }), n())!, /below critical/);
	assert.equal(routeMatches(opts({ minSeverity: 'critical' }), n({ severity: 'critical' })), null);
	assert.match(routeMatches(opts({ ruleKinds: ['unreachable'] }), n())!, /rule/);
	assert.equal(routeMatches(opts({ ruleKinds: ['unreachable', 'long_query'] }), n()), null);
	assert.match(routeMatches(opts({ connectionIds: ['c2'] }), n())!, /connection/);
	assert.equal(routeMatches(opts({ connectionIds: ['c1'] }), n()), null);
	assert.match(routeMatches(opts({ sendResolved: false }), n({ event: 'resolved' }))!, /resolved/);
	assert.match(routeMatches(opts({ sendRenotify: false }), n({ event: 'renotified' }))!, /reminders/);
	assert.equal(routeMatches(opts({ ruleKinds: ['unreachable'], minSeverity: 'critical' }), n({ event: 'test', rule: null, connection: null })), null, 'tests always route');
});

test('quiet hours: same-day and overnight windows, in a time zone', () => {
	const q = { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowCritical: true };
	assert.equal(inQuietHours(q, at('23:30')), true);
	assert.equal(inQuietHours(q, at('03:00')), true);
	assert.equal(inQuietHours(q, at('07:00')), false, 'end is exclusive');
	assert.equal(inQuietHours(q, at('12:00')), false);
	assert.equal(inQuietHours({ ...q, start: '09:00', end: '17:00' }, at('12:00')), true);
	assert.equal(inQuietHours({ ...q, start: '09:00', end: '17:00' }, at('18:00')), false);
	assert.equal(inQuietHours({ ...q, enabled: false }, at('23:30')), false);
	assert.equal(inQuietHours({ ...q, start: '07:00', end: '07:00' }, at('07:00')), false, 'empty window');
	// 21:30 UTC is 23:30 in Berlin (CEST) on 9 Oct.
	assert.equal(minutesOfDay(at('21:30'), 'Europe/Berlin'), 23 * 60 + 30);
	assert.equal(inQuietHours({ ...q, timezone: 'Europe/Berlin' }, at('21:30')), true);
	assert.equal(inQuietHours({ ...q, timezone: 'UTC' }, at('21:30')), false);
});

test('decide: quiet hours hold back warnings but let critical through when allowed', () => {
	const quiet = opts({ quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC', allowCritical: true } });
	const held = decide(quiet, n(), at('23:00'), none);
	assert.equal(held.send, false);
	assert.match(!held.send ? held.reason : '', /Quiet hours \(22:00–07:00 UTC\)/);
	assert.deepEqual(decide(quiet, n({ severity: 'critical' }), at('23:00'), none), { send: true });
	assert.deepEqual(decide(quiet, n({ severity: 'critical', event: 'resolved' }), at('23:00'), none), { send: true }, 'and its recovery');
	const strict = opts({ quietHours: { ...quiet.quietHours, allowCritical: false } });
	assert.equal(decide(strict, n({ severity: 'critical' }), at('23:00'), none).send, false);
	assert.deepEqual(decide(strict, n({ event: 'test' }), at('23:00'), none), { send: true }, 'tests ignore quiet hours');
	assert.deepEqual(decide(quiet, n(), at('12:00'), none), { send: true });
});

test('decide: de-duplication and the hourly limit', () => {
	const now = at('12:00');
	const o = opts({ dedupeMinutes: 10, maxPerHour: 3 });
	assert.deepEqual(decide(o, n(), now, { lastHour: 0, lastSameAt: now.getTime() - 9 * 60_000 }).send, false);
	assert.deepEqual(decide(o, n(), now, { lastHour: 0, lastSameAt: now.getTime() - 11 * 60_000 }), { send: true });
	const limited = decide(o, n(), now, { lastHour: 3, lastSameAt: null });
	assert.match(!limited.send ? limited.reason : '', /Rate limit \(3 per hour\)/);
	assert.deepEqual(decide(o, n(), now, { lastHour: 2, lastSameAt: null }), { send: true });
	assert.deepEqual(decide(o, n({ severity: 'critical' }), now, { lastHour: 99, lastSameAt: null }), { send: true }, 'a new critical alert skips the limit');
	assert.equal(decide(o, n({ severity: 'critical', event: 'renotified' }), now, { lastHour: 99, lastSameAt: null }).send, false);
	assert.deepEqual(decide(opts(), n(), now, { lastHour: 1000, lastSameAt: now.getTime() }), { send: true }, '0 means off');
	assert.equal(dedupeKey(n()), 'r1:c1:fired');
	assert.notEqual(dedupeKey(n()), dedupeKey(n({ event: 'resolved' })));
	assert.equal(dedupeKey(n({ event: 'test' })), null);
});
