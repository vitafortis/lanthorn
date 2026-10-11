/**
 * Per-channel delivery policy, pure: routing (which alerts a channel wants), quiet
 * hours, rate limiting and de-duplication. The job asks `decide()` before sending.
 */
import { DEFAULT_CHANNEL_OPTIONS, RULE_KINDS, type ChannelOptions, type QuietHours, type Severity } from '#lib/alerts.ts';
import type { Notification } from './notify.ts';

const RANK: Record<Severity, number> = { warning: 1, critical: 2 };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validTimezone(tz: string): boolean {
	if (!tz) return true;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Fills in and clamps options from untrusted input or an older stored shape. */
export function normalizeOptions(raw: unknown, knownConnections?: (id: string) => boolean): ChannelOptions {
	const d = DEFAULT_CHANNEL_OPTIONS;
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const q = o.quietHours && typeof o.quietHours === 'object' ? (o.quietHours as Record<string, unknown>) : {};
	const num = (v: unknown, def: number, max: number) => {
		const n = Number(v);
		return v === undefined || v === null || v === '' || !Number.isFinite(n) ? def : Math.min(max, Math.max(0, Math.round(n)));
	};
	const tz = typeof q.timezone === 'string' ? q.timezone.trim() : '';
	return {
		minSeverity: o.minSeverity === 'critical' ? 'critical' : 'warning',
		ruleKinds: Array.isArray(o.ruleKinds) ? [...new Set(o.ruleKinds.filter((k): k is (typeof RULE_KINDS)[number] => (RULE_KINDS as unknown[]).includes(k)))] : [],
		connectionIds: Array.isArray(o.connectionIds)
			? [...new Set(o.connectionIds.filter((c): c is string => typeof c === 'string' && !!c && (!knownConnections || knownConnections(c))))]
			: [],
		sendResolved: o.sendResolved !== false,
		sendRenotify: o.sendRenotify !== false,
		quietHours: {
			enabled: q.enabled === true,
			start: typeof q.start === 'string' && HHMM.test(q.start) ? q.start : d.quietHours.start,
			end: typeof q.end === 'string' && HHMM.test(q.end) ? q.end : d.quietHours.end,
			timezone: validTimezone(tz) ? tz : '',
			allowCritical: q.allowCritical !== false
		},
		maxPerHour: num(o.maxPerHour, d.maxPerHour, 10_000),
		dedupeMinutes: num(o.dedupeMinutes, d.dedupeMinutes, 7 * 24 * 60)
	};
}

/** Minutes since local midnight in `timezone` (the server's when empty). */
export function minutesOfDay(at: Date, timezone: string): number {
	const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timezone ? { timeZone: timezone } : {}) }).formatToParts(at);
	const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
	const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
	return h * 60 + m;
}

const toMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Whether `at` falls in the quiet window; windows may wrap midnight (22:00–07:00). */
export function inQuietHours(q: QuietHours, at: Date): boolean {
	if (!q.enabled) return false;
	const start = toMinutes(q.start);
	const end = toMinutes(q.end);
	if (start === end) return false;
	const now = minutesOfDay(at, q.timezone);
	return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Whether a channel's routing wants this notification at all. Tests always pass. */
export function routeMatches(o: ChannelOptions, n: Notification): string | null {
	if (n.event === 'test') return null;
	if (RANK[n.severity] < RANK[o.minSeverity]) return `below ${o.minSeverity}`;
	if (n.event === 'resolved' && !o.sendResolved) return 'resolved notifications off';
	if (n.event === 'renotified' && !o.sendRenotify) return 'reminders off';
	if (o.ruleKinds.length && (!n.rule || !o.ruleKinds.includes(n.rule.kind))) return 'rule not routed here';
	if (o.connectionIds.length && (!n.connection || !o.connectionIds.includes(n.connection.id))) return 'connection not routed here';
	return null;
}

/** What one channel has recently sent, as far as the policy cares. */
export interface RecentDeliveries {
	/** Notifications sent (or in flight) in the last hour. */
	lastHour: number;
	/** When this same alert event was last sent here (epoch ms), if ever. */
	lastSameAt: number | null;
}

/** Identifies "the same alert event" for de-duplication. */
export function dedupeKey(n: Notification): string | null {
	if (n.event === 'test' || !n.rule) return null;
	return `${n.rule.id}:${n.connection?.id ?? '-'}:${n.event}`;
}

export type Decision = { send: true } | { send: false; reason: string };

/**
 * Whether to send `n` to a channel now. Order: routing, quiet hours (critical may
 * pass), de-duplication, then the hourly limit (a newly firing critical alert skips
 * it). Test notifications always go out.
 */
export function decide(o: ChannelOptions, n: Notification, now: Date, recent: RecentDeliveries): Decision {
	if (n.event === 'test') return { send: true };
	const route = routeMatches(o, n);
	if (route) return { send: false, reason: `Not routed: ${route}` };
	if (inQuietHours(o.quietHours, now) && !(o.quietHours.allowCritical && n.severity === 'critical')) {
		return { send: false, reason: `Quiet hours (${o.quietHours.start}–${o.quietHours.end}${o.quietHours.timezone ? ` ${o.quietHours.timezone}` : ''})` };
	}
	if (o.dedupeMinutes > 0 && recent.lastSameAt != null && now.getTime() - recent.lastSameAt < o.dedupeMinutes * 60_000) {
		return { send: false, reason: `Duplicate within ${o.dedupeMinutes} min` };
	}
	// A newly firing critical alert is never held back by a flood of lesser ones.
	const exempt = n.severity === 'critical' && n.event === 'fired';
	if (o.maxPerHour > 0 && !exempt && recent.lastHour >= o.maxPerHour) return { send: false, reason: `Rate limit (${o.maxPerHour} per hour)` };
	return { send: true };
}
