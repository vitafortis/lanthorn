/** Validation of alert API request bodies. */
import { BadRequest } from '../http.ts';
import { getConnection } from '../store.ts';
import { cleanParams, type ChannelInput, type RuleInput } from './store.ts';
import { normalizeOptions, validTimezone } from './policy.ts';
import { CHANNELS, isChannelKind, isRuleKind, type AlertSettings, type ChannelField, type ChannelOptions } from '#lib/alerts.ts';

function obj(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Expected a JSON object');
	return body as Record<string, unknown>;
}

const strings = (v: unknown): Record<string, string | undefined> =>
	v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, typeof x === 'string' ? x : undefined])) : {};

function checkUrl(label: string, v: string | undefined) {
	if (!v) return;
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		throw new BadRequest(`${label} must be a URL`);
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequest(`${label} must be an http(s) URL`);
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Checks one field's value by its type; secrets only when a new value was typed. */
function checkField(f: ChannelField, v: string | undefined) {
	if (!v) return;
	if (f.type === 'url') checkUrl(f.label, v);
	else if (f.type === 'number' && !/^\d{1,5}$/.test(v)) throw new BadRequest(`${f.label} must be a number`);
	else if (f.type === 'select' && f.options && !f.options.some((o) => o.value === v)) throw new BadRequest(`${f.label}: choose one of the options`);
	else if (f.type === 'emails') {
		const bad = v.split(/[,;\s]+/).filter((x) => x && !EMAIL.test(x));
		if (bad.length) throw new BadRequest(`${f.label}: not an email address: ${bad.join(', ')}`);
	}
}

/** `current`: the stored channel's options, kept when the body has none (e.g. an enable toggle). */
export function parseChannelInput(body: unknown, current?: ChannelOptions): ChannelInput {
	const b = obj(body);
	if (!isChannelKind(b.kind)) throw new BadRequest('Unknown channel type');
	const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : CHANNELS[b.kind].label;
	const config = Object.fromEntries(
		Object.entries(strings(b.config))
			.filter((e): e is [string, string] => e[1] !== undefined)
			.map(([k, v]) => [k, v.slice(0, 2000)])
	);
	// Only explicit non-empty strings replace a stored secret; '' with `clear` removes it.
	const raw = strings(b.secrets);
	const clear = Array.isArray(b.clearSecrets) ? (b.clearSecrets as unknown[]).filter((x): x is string => typeof x === 'string') : [];
	const secrets: Record<string, string | undefined> = {};
	for (const f of CHANNELS[b.kind].fields.filter((f) => f.secret)) {
		if (clear.includes(f.key)) secrets[f.key] = '';
		else if (raw[f.key]?.trim()) secrets[f.key] = raw[f.key]!.trim().slice(0, 4000);
	}
	for (const f of CHANNELS[b.kind].fields) checkField(f, f.secret ? secrets[f.key] : config[f.key]?.trim());
	const tz = (b.options as { quietHours?: { timezone?: unknown } } | undefined)?.quietHours?.timezone;
	if (typeof tz === 'string' && tz.trim() && !validTimezone(tz.trim())) throw new BadRequest(`Unknown time zone: ${tz.trim()}`);
	const options = b.options === undefined && current ? current : normalizeOptions(b.options, (id) => !!getConnection(id));
	return { name, kind: b.kind, enabled: b.enabled !== false, config, options, secrets };
}

export function parseRuleInput(body: unknown): RuleInput {
	const b = obj(body);
	if (!isRuleKind(b.kind)) throw new BadRequest('Unknown rule type');
	let connectionId: string | null = null;
	if (typeof b.connectionId === 'string' && b.connectionId) {
		if (!getConnection(b.connectionId)) throw new BadRequest('Unknown connection');
		connectionId = b.connectionId;
	}
	return {
		kind: b.kind,
		connectionId,
		enabled: b.enabled !== false,
		params: cleanParams(b.kind, b.params && typeof b.params === 'object' ? (b.params as Record<string, unknown>) : {}),
		notifyResolved: b.notifyResolved !== false
	};
}

export function parseSettings(body: unknown): AlertSettings {
	const b = obj(body);
	const interval = Number(b.intervalSeconds);
	const renotify = Number(b.renotifyHours);
	const publicUrl = typeof b.publicUrl === 'string' ? b.publicUrl.trim().replace(/\/+$/, '') : '';
	checkUrl('Public URL', publicUrl || undefined);
	return {
		intervalSeconds: Number.isFinite(interval) ? Math.min(3600, Math.max(30, Math.round(interval))) : 60,
		renotifyHours: Number.isFinite(renotify) ? Math.min(24 * 30, Math.max(0, renotify)) : 6,
		publicUrl
	};
}
