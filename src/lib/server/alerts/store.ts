/**
 * Alert channels, rules, per-(rule, connection) state, the event history and the
 * per-channel delivery log, in the SQLite store (tables created by store.ts `migrateAlerts`).
 */
import { randomUUID } from 'node:crypto';
import { getKv, setKv, sqlite } from '../store.ts';
import { decrypt, encrypt } from '../crypto.ts';
import { secretHint } from './notify.ts';
import { normalizeOptions, type RecentDeliveries } from './policy.ts';
import type { RuleState, Status } from './state.ts';
import {
	CHANNELS,
	DEFAULT_ALERT_SETTINGS,
	RULE_KINDS,
	RULES,
	defaultParams,
	fieldVisible,
	isChannelKind,
	type ActiveAlert,
	type AlertChannel,
	type AlertDelivery,
	type ChannelOptions,
	type DeliveryStatus,
	type AlertEvent,
	type AlertRule,
	type AlertRuleKind,
	type AlertSettings,
	type AlertTransition,
	type ChannelKind,
	type FiringSummary,
	type Severity
} from '#lib/alerts.ts';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

function parseJson<T>(v: unknown, fallback: T): T {
	try {
		return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
	} catch {
		return fallback;
	}
}

// --- settings ------------------------------------------------------------------------

export function alertSettings(): AlertSettings {
	return { ...DEFAULT_ALERT_SETTINGS, ...getKv<Partial<AlertSettings>>('alerts:settings', {}) };
}

export function saveAlertSettings(s: AlertSettings) {
	setKv('alerts:settings', s);
}

// --- channels ------------------------------------------------------------------------

const channelContext = (id: string) => `alert-channel:${id}`;

function secretsOf(r: Row): Record<string, string> {
	return r.secret ? parseJson<Record<string, string>>(decrypt(r.secret as string, channelContext(r.id as string)), {}) : {};
}

function toChannel(r: Row): AlertChannel {
	const secrets = secretsOf(r);
	return {
		id: r.id as string,
		name: r.name as string,
		kind: r.kind as ChannelKind,
		enabled: r.enabled === 1,
		config: parseJson(r.config, {}),
		options: normalizeOptions(parseJson(r.options, {})),
		secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v).map(([k, v]) => [k, secretHint(v)])),
		lastSentAt: (r.last_sent_at as string) ?? null,
		lastError: (r.last_error as string) ?? null,
		createdAt: r.created_at as string
	};
}

let migrated = false;

/**
 * One-time upgrade of channels stored by earlier versions: "Slack-compatible" channels
 * keep the classic attachment format unless they point at Slack itself (which gets
 * Block Kit), and every channel gets explicit routing/limit options.
 */
export function migrateChannels() {
	if (migrated) return;
	migrated = true;
	if (getKv('migration:alert-channels-v2', false)) return;
	const h = sqlite();
	for (const r of h.prepare('SELECT * FROM alert_channels').all() as Row[]) {
		const config = parseJson<Record<string, string>>(r.config, {});
		if (r.kind === 'slack' && !config.format) {
			let host = '';
			try {
				host = new URL(secretsOf(r).url ?? '').hostname;
			} catch {
				// unreadable or no URL: classic is the safe choice
			}
			config.format = host === 'hooks.slack.com' ? 'blocks' : 'attachments';
		}
		const options = normalizeOptions(parseJson(r.options, {}));
		h.prepare('UPDATE alert_channels SET config = ?, options = ? WHERE id = ?').run(JSON.stringify(config), JSON.stringify(options), r.id as string);
	}
	setKv('migration:alert-channels-v2', true);
}

export function listChannels(): AlertChannel[] {
	migrateChannels();
	return (sqlite().prepare('SELECT * FROM alert_channels ORDER BY name COLLATE NOCASE').all() as Row[]).map(toChannel);
}

export function getChannel(id: string): AlertChannel | undefined {
	migrateChannels();
	const r = sqlite().prepare('SELECT * FROM alert_channels WHERE id = ?').get(id) as Row | undefined;
	return r && toChannel(r);
}

/** A channel with its decrypted secrets, for sending. Server-side only. */
export function channelWithSecrets(id: string): { channel: AlertChannel; secrets: Record<string, string> } | undefined {
	migrateChannels();
	const r = sqlite().prepare('SELECT * FROM alert_channels WHERE id = ?').get(id) as Row | undefined;
	return r && { channel: toChannel(r), secrets: secretsOf(r) };
}

export interface ChannelInput {
	name: string;
	kind: ChannelKind;
	enabled: boolean;
	config: Record<string, string>;
	options: ChannelOptions;
	/** Secret fields; a missing or undefined key keeps the stored value, '' clears it. */
	secrets: Record<string, string | undefined>;
}

/** Keeps unchanged secrets of the fields that apply; drops the rest. */
function mergeSecrets(kind: ChannelKind, config: Record<string, string>, existing: Record<string, string>, incoming: Record<string, string | undefined>) {
	const out: Record<string, string> = {};
	for (const f of CHANNELS[kind].fields.filter((f) => f.secret && fieldVisible(f, config, kind))) {
		const v = incoming[f.key];
		if (v === undefined) {
			if (existing[f.key]) out[f.key] = existing[f.key];
		} else if (v) out[f.key] = v;
	}
	return out;
}

/** Fields the kind requires that are missing after merging; empty when complete. */
export function missingFields(kind: ChannelKind, config: Record<string, string>, secrets: Record<string, string>): string[] {
	return CHANNELS[kind].fields.filter((f) => f.required && fieldVisible(f, config, kind) && !(f.secret ? secrets[f.key] : config[f.key])).map((f) => f.label);
}

/** Resolves an input against the stored channel (for tests of unsaved edits, too). */
export function resolveChannelInput(input: ChannelInput, id?: string): { config: Record<string, string>; secrets: Record<string, string> } {
	const existing = id ? (channelWithSecrets(id)?.secrets ?? {}) : {};
	const config: Record<string, string> = {};
	for (const f of CHANNELS[input.kind].fields.filter((f) => !f.secret)) {
		const v = input.config[f.key];
		if (typeof v === 'string' && v.trim()) config[f.key] = v.trim();
		else if (f.type === 'select' && f.default) config[f.key] = f.default;
	}
	for (const f of CHANNELS[input.kind].fields) if (!f.secret && !fieldVisible(f, config, input.kind)) delete config[f.key];
	return { config, secrets: mergeSecrets(input.kind, config, existing, input.secrets) };
}

export function createChannel(input: ChannelInput): AlertChannel {
	const id = randomUUID();
	const { config, secrets } = resolveChannelInput(input);
	const t = now();
	sqlite()
		.prepare('INSERT INTO alert_channels (id, name, kind, config, options, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
		.run(id, input.name, input.kind, JSON.stringify(config), JSON.stringify(input.options), encrypt(JSON.stringify(secrets), channelContext(id)), input.enabled ? 1 : 0, t, t);
	return getChannel(id)!;
}

export function updateChannel(id: string, input: ChannelInput): AlertChannel | undefined {
	if (!getChannel(id)) return undefined;
	const { config, secrets } = resolveChannelInput(input, id);
	sqlite()
		.prepare('UPDATE alert_channels SET name = ?, kind = ?, config = ?, options = ?, secret = ?, enabled = ?, updated_at = ? WHERE id = ?')
		.run(input.name, input.kind, JSON.stringify(config), JSON.stringify(input.options), encrypt(JSON.stringify(secrets), channelContext(id)), input.enabled ? 1 : 0, now(), id);
	return getChannel(id);
}

export function deleteChannel(id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM alert_channels WHERE id = ?').run(id).changes) > 0;
}

export function recordDelivery(id: string, error: string | null) {
	if (error) sqlite().prepare('UPDATE alert_channels SET last_error = ? WHERE id = ?').run(error, id);
	else sqlite().prepare('UPDATE alert_channels SET last_sent_at = ?, last_error = NULL WHERE id = ?').run(now(), id);
}

// --- rules ---------------------------------------------------------------------------

function toRule(r: Row): AlertRule {
	const kind = r.kind as AlertRuleKind;
	return {
		id: r.id as string,
		kind,
		connectionId: (r.connection_id as string) ?? null,
		enabled: r.enabled === 1,
		params: { ...defaultParams(kind), ...parseJson<Record<string, number>>(r.params, {}) },
		notifyResolved: r.notify_resolved === 1,
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string
	};
}

export function listRules(): AlertRule[] {
	const rows = sqlite().prepare('SELECT * FROM alert_rules ORDER BY connection_id IS NOT NULL, created_at').all() as Row[];
	return rows.filter((r) => (RULE_KINDS as string[]).includes(r.kind as string)).map(toRule);
}

export function getRule(id: string): AlertRule | undefined {
	const r = sqlite().prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as Row | undefined;
	return r && toRule(r);
}

export interface RuleInput {
	kind: AlertRuleKind;
	connectionId: string | null;
	enabled: boolean;
	params: Record<string, number>;
	notifyResolved: boolean;
}

/** Keeps only the kind's known parameters, clamped to their ranges. */
export function cleanParams(kind: AlertRuleKind, params: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const p of RULES[kind].params) {
		const v = Number(params[p.key]);
		out[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
	}
	return out;
}

export function createRule(input: RuleInput): AlertRule {
	const id = randomUUID();
	const t = now();
	sqlite()
		.prepare('INSERT INTO alert_rules (id, kind, connection_id, enabled, params, notify_resolved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.run(id, input.kind, input.connectionId, input.enabled ? 1 : 0, JSON.stringify(cleanParams(input.kind, input.params)), input.notifyResolved ? 1 : 0, t, t);
	return getRule(id)!;
}

export function updateRule(id: string, input: RuleInput): AlertRule | undefined {
	const existing = getRule(id);
	if (!existing) return undefined;
	sqlite()
		.prepare('UPDATE alert_rules SET kind = ?, connection_id = ?, enabled = ?, params = ?, notify_resolved = ?, updated_at = ? WHERE id = ?')
		.run(input.kind, input.connectionId, input.enabled ? 1 : 0, JSON.stringify(cleanParams(input.kind, input.params)), input.notifyResolved ? 1 : 0, now(), id);
	// A different kind or scope is a different alert: start its state over.
	if (existing.kind !== input.kind || existing.connectionId !== input.connectionId) sqlite().prepare('DELETE FROM alert_state WHERE rule_id = ?').run(id);
	return getRule(id);
}

export function deleteRule(id: string): boolean {
	return Number(sqlite().prepare('DELETE FROM alert_rules WHERE id = ?').run(id).changes) > 0;
}

/** Adds the default rule set for every connection (kinds that already have a global rule are skipped). */
export function addDefaultRules(): AlertRule[] {
	const existing = new Set(listRules().filter((r) => r.connectionId === null).map((r) => r.kind));
	const added: AlertRule[] = [];
	for (const kind of RULE_KINDS) {
		if (existing.has(kind)) continue;
		added.push(createRule({ kind, connectionId: null, enabled: RULES[kind].defaultEnabled, params: defaultParams(kind), notifyResolved: true }));
	}
	setKv('alerts:defaults-added', true);
	return added;
}

/** Seeds the default rules the first time a channel is created, unless rules already exist. */
export function seedDefaultRulesOnce(): AlertRule[] {
	if (getKv('alerts:defaults-added', false) || listRules().length) return [];
	return addDefaultRules();
}

// --- state ---------------------------------------------------------------------------

export interface StoredState extends RuleState {
	ruleId: string;
	connectionId: string;
}

function toState(r: Row): StoredState {
	return {
		ruleId: r.rule_id as string,
		connectionId: r.connection_id as string,
		status: r.status as Status,
		streak: r.streak as number,
		since: (r.since as number) ?? null,
		lastNotifiedAt: (r.last_notified_at as number) ?? null,
		message: (r.message as string) ?? null,
		value: (r.value as number) ?? null
	};
}

export function listStates(): StoredState[] {
	return (sqlite().prepare('SELECT * FROM alert_state').all() as Row[]).map(toState);
}

export function saveState(ruleId: string, connectionId: string, s: RuleState) {
	sqlite()
		.prepare(
			`INSERT INTO alert_state (rule_id, connection_id, status, streak, since, last_notified_at, message, value, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(rule_id, connection_id) DO UPDATE SET status = excluded.status, streak = excluded.streak, since = excluded.since,
				last_notified_at = excluded.last_notified_at, message = excluded.message, value = excluded.value, updated_at = excluded.updated_at`
		)
		.run(ruleId, connectionId, s.status, s.streak, s.since, s.lastNotifiedAt, s.message, s.value, Date.now());
}

export function deleteState(ruleId: string, connectionId: string) {
	sqlite().prepare('DELETE FROM alert_state WHERE rule_id = ? AND connection_id = ?').run(ruleId, connectionId);
}

/** Firing alerts, joined with their rule and connection. */
export function activeAlerts(): ActiveAlert[] {
	const rows = sqlite()
		.prepare(
			`SELECT s.*, r.kind, c.name AS connection_name FROM alert_state s
			 JOIN alert_rules r ON r.id = s.rule_id JOIN connections c ON c.id = s.connection_id
			 WHERE s.status = 'firing' ORDER BY s.since DESC`
		)
		.all() as Row[];
	return rows
		.filter((r) => (RULE_KINDS as string[]).includes(r.kind as string))
		.map((r) => {
			const kind = r.kind as AlertRuleKind;
			return {
				ruleId: r.rule_id as string,
				ruleKind: kind,
				connectionId: r.connection_id as string,
				connectionName: r.connection_name as string,
				severity: RULES[kind].severity,
				since: new Date(r.since as number).toISOString(),
				message: (r.message as string) ?? '',
				lastNotifiedAt: r.last_notified_at ? new Date(r.last_notified_at as number).toISOString() : null
			};
		});
}

/** Firing alerts per connection id, limited to `connectionIds`. */
export function firingSummary(connectionIds: string[]): Record<string, FiringSummary> {
	const allowed = new Set(connectionIds);
	const out: Record<string, FiringSummary> = {};
	for (const a of activeAlerts()) {
		if (!allowed.has(a.connectionId)) continue;
		const s = (out[a.connectionId] ??= { count: 0, critical: false, titles: [] });
		s.count++;
		s.critical ||= a.severity === 'critical';
		s.titles.push(RULES[a.ruleKind].label);
	}
	return out;
}

// --- events --------------------------------------------------------------------------

export function addEvent(e: {
	ruleId: string | null;
	ruleKind: AlertRuleKind;
	connectionId: string | null;
	connectionName: string | null;
	event: AlertTransition;
	severity: Severity;
	message: string;
}): number {
	const h = sqlite();
	const r = h
		.prepare(
			'INSERT INTO alert_events (at, rule_id, rule_kind, connection_id, connection_name, event, severity, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.run(now(), e.ruleId, e.ruleKind, e.connectionId, e.connectionName, e.event, e.severity, e.message);
	h.prepare('DELETE FROM alert_events WHERE id <= (SELECT max(id) - 5000 FROM alert_events)').run();
	return Number(r.lastInsertRowid);
}

export function recordEventDelivery(id: number, delivered: number, errors: string[]) {
	sqlite()
		.prepare('UPDATE alert_events SET delivered = ?, error = ? WHERE id = ?')
		.run(delivered, errors.length ? errors.join('; ').slice(0, 1000) : null, id);
}

export function listEvents(opts: { before?: number; limit?: number; connectionId?: string } = {}): AlertEvent[] {
	const where: string[] = [];
	const values: (string | number)[] = [];
	if (opts.before) where.push('id < ?'), values.push(opts.before);
	if (opts.connectionId) where.push('connection_id = ?'), values.push(opts.connectionId);
	const rows = sqlite()
		.prepare(`SELECT * FROM alert_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
		.all(...values, Math.min(opts.limit ?? 100, 500)) as Row[];
	return rows.map((r) => ({
		id: r.id as number,
		at: r.at as string,
		ruleId: (r.rule_id as string) ?? null,
		ruleKind: r.rule_kind as AlertRuleKind,
		connectionId: (r.connection_id as string) ?? null,
		connectionName: (r.connection_name as string) ?? null,
		event: r.event as AlertTransition,
		severity: r.severity as Severity,
		message: r.message as string,
		delivered: r.delivered as number,
		error: (r.error as string) ?? null
	}));
}

// --- delivery log ----------------------------------------------------------------------

const KEEP_DELIVERIES = 5000;

/** Starts a log entry: 'sending' (counts towards limits right away) or 'suppressed'. */
export function addDelivery(d: {
	channel: Pick<AlertChannel, 'name' | 'kind'> & { id: string | null };
	eventId: number | null;
	event: AlertTransition | 'test';
	severity: Severity;
	title: string;
	connectionName: string | null;
	dedupeKey: string | null;
	status: DeliveryStatus;
	detail?: string | null;
	at?: number;
}): number {
	const h = sqlite();
	const r = h
		.prepare(
			`INSERT INTO alert_deliveries (at, channel_id, channel_name, channel_kind, event_id, event, severity, title, connection_name, dedupe_key, status, detail)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(d.at ?? Date.now(), d.channel.id, d.channel.name, d.channel.kind, d.eventId, d.event, d.severity, d.title, d.connectionName, d.dedupeKey, d.status, d.detail ?? null);
	h.prepare('DELETE FROM alert_deliveries WHERE id <= (SELECT max(id) - ? FROM alert_deliveries)').run(KEEP_DELIVERIES);
	return Number(r.lastInsertRowid);
}

export function finishDelivery(id: number, status: 'sent' | 'failed', detail: string | null, durationMs: number) {
	sqlite().prepare('UPDATE alert_deliveries SET status = ?, detail = ?, duration_ms = ? WHERE id = ?').run(status, detail?.slice(0, 1000) ?? null, Math.round(durationMs), id);
}

/** What the policy needs to know about a channel's recent sends. */
export function recentDeliveries(channelId: string, dedupeKey: string | null, at = Date.now()): RecentDeliveries {
	const h = sqlite();
	const lastHour = (
		h
			.prepare(`SELECT count(*) AS n FROM alert_deliveries WHERE channel_id = ? AND at > ? AND status IN ('sending', 'sent') AND event != 'test'`)
			.get(channelId, at - 3_600_000) as { n: number }
	).n;
	const same = dedupeKey
		? (h.prepare(`SELECT max(at) AS at FROM alert_deliveries WHERE channel_id = ? AND dedupe_key = ? AND status IN ('sending', 'sent')`).get(channelId, dedupeKey) as {
				at: number | null;
			})
		: null;
	return { lastHour, lastSameAt: same?.at ?? null };
}

export function listDeliveries(opts: { before?: number; limit?: number; channelId?: string } = {}): AlertDelivery[] {
	const where: string[] = [];
	const values: (string | number)[] = [];
	if (opts.before) where.push('id < ?'), values.push(opts.before);
	if (opts.channelId) where.push('channel_id = ?'), values.push(opts.channelId);
	const rows = sqlite()
		.prepare(`SELECT * FROM alert_deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
		.all(...values, Math.min(Math.max(1, opts.limit ?? 50), 500)) as Row[];
	return rows.map((r) => ({
		id: r.id as number,
		at: new Date(r.at as number).toISOString(),
		channelId: (r.channel_id as string) ?? null,
		channelName: r.channel_name as string,
		channelKind: r.channel_kind as ChannelKind,
		eventId: (r.event_id as number) ?? null,
		event: r.event as AlertDelivery['event'],
		severity: r.severity as Severity,
		title: r.title as string,
		connectionName: (r.connection_name as string) ?? null,
		status: r.status as DeliveryStatus,
		detail: (r.detail as string) ?? null,
		durationMs: (r.duration_ms as number) ?? null
	}));
}

// --- backup ----------------------------------------------------------------------------

/** Alert configuration as it travels in an encrypted config backup (secrets in the clear). */
export interface AlertBackup {
	settings: AlertSettings;
	channels: {
		id: string;
		name: string;
		kind: ChannelKind;
		enabled: boolean;
		config: Record<string, string>;
		options: ChannelOptions;
		secrets: Record<string, string>;
		createdAt: string;
	}[];
	rules: Omit<AlertRule, 'updatedAt'>[];
}

export function exportAlertConfig(): AlertBackup {
	migrateChannels();
	const rows = sqlite().prepare('SELECT * FROM alert_channels ORDER BY name COLLATE NOCASE').all() as Row[];
	return {
		settings: alertSettings(),
		channels: rows.map((r) => {
			const c = toChannel(r);
			return { id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, config: c.config, options: c.options, secrets: secretsOf(r), createdAt: c.createdAt };
		}),
		rules: listRules().map(({ updatedAt: _, ...r }) => r)
	};
}

/**
 * Replaces the alert configuration with a backed-up one (inside the caller's
 * transaction), like the other settings: channels and rules not in the backup are
 * removed, the rest written by id with secrets re-sealed under this install's key.
 * Rules for connections that don't exist here are skipped. The history and delivery
 * log are kept.
 */
export function importAlertConfig(b: AlertBackup): { channels: number; rules: number; skippedRules: number } {
	const h = sqlite();
	const t = now();
	const out = { channels: 0, rules: 0, skippedRules: 0 };
	if (b.settings && typeof b.settings === 'object') setKv('alerts:settings', { ...DEFAULT_ALERT_SETTINGS, ...b.settings });
	const keepChannels = (Array.isArray(b.channels) ? b.channels : []).map((c) => c?.id).filter((id): id is string => typeof id === 'string');
	const keepRules = (Array.isArray(b.rules) ? b.rules : []).map((r) => r?.id).filter((id): id is string => typeof id === 'string');
	h.prepare(`DELETE FROM alert_channels WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keepChannels));
	h.prepare(`DELETE FROM alert_rules WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(keepRules));
	const upsertChannel = h.prepare(
		`INSERT INTO alert_channels (id, name, kind, config, options, secret, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, config = excluded.config, options = excluded.options,
			secret = excluded.secret, enabled = excluded.enabled, updated_at = excluded.updated_at`
	);
	for (const c of Array.isArray(b.channels) ? b.channels : []) {
		if (typeof c?.id !== 'string' || !c.id || !isChannelKind(c.kind)) continue;
		const strings = (v: unknown) =>
			Object.fromEntries(Object.entries(v && typeof v === 'object' ? (v as Record<string, unknown>) : {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
		upsertChannel.run(
			c.id,
			String(c.name || CHANNELS[c.kind].label).slice(0, 80),
			c.kind,
			JSON.stringify(strings(c.config)),
			JSON.stringify(normalizeOptions(c.options)),
			encrypt(JSON.stringify(strings(c.secrets)), channelContext(c.id)),
			c.enabled === false ? 0 : 1,
			c.createdAt || t,
			t
		);
		out.channels++;
	}
	const connExists = h.prepare('SELECT 1 FROM connections WHERE id = ?');
	const upsertRule = h.prepare(
		`INSERT INTO alert_rules (id, kind, connection_id, enabled, params, notify_resolved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, connection_id = excluded.connection_id, enabled = excluded.enabled,
			params = excluded.params, notify_resolved = excluded.notify_resolved, updated_at = excluded.updated_at`
	);
	for (const r of Array.isArray(b.rules) ? b.rules : []) {
		if (typeof r?.id !== 'string' || !(RULE_KINDS as string[]).includes(r.kind)) continue;
		if (r.connectionId && !connExists.get(r.connectionId)) {
			out.skippedRules++;
			continue;
		}
		upsertRule.run(r.id, r.kind, r.connectionId ?? null, r.enabled === false ? 0 : 1, JSON.stringify(cleanParams(r.kind, r.params ?? {})), r.notifyResolved === false ? 0 : 1, r.createdAt || t, t);
		out.rules++;
	}
	if (out.rules) setKv('alerts:defaults-added', true);
	return out;
}
