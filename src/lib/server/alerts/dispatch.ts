/**
 * Turning alert transitions into notifications and sending them to channels through
 * each channel's policy, with every attempt in the delivery log.
 */
import { deliver, type Notification, type SendDeps } from './notify.ts';
import { decide, dedupeKey } from './policy.ts';
import { addDelivery, alertSettings, channelWithSecrets, finishDelivery, listChannels, recentDeliveries, recordDelivery } from './store.ts';
import { RULES, type AlertChannel, type AlertRuleKind } from '#lib/alerts.ts';
import type { Connection } from '#lib/types.ts';

export function notificationFor(
	rule: { id: string; kind: AlertRuleKind } | null,
	conn: Pick<Connection, 'id' | 'name' | 'engine'> | null,
	event: Notification['event'],
	message: string,
	extra: { value?: number | null; since?: number | null } = {}
): Notification {
	const { publicUrl } = alertSettings();
	const kind = rule?.kind;
	return {
		event,
		severity: kind ? RULES[kind].severity : 'warning',
		title: kind ? RULES[kind].label : 'Test notification',
		message,
		connection: conn ? { id: conn.id, name: conn.name, engine: conn.engine } : null,
		rule: rule ? { id: rule.id, kind: rule.kind } : null,
		value: extra.value ?? null,
		since: extra.since ? new Date(extra.since).toISOString() : null,
		at: new Date().toISOString(),
		url: publicUrl ? `${publicUrl.replace(/\/+$/, '')}${conn ? `/c/${encodeURIComponent(conn.id)}` : '/alerts'}` : null
	};
}

/** A channel ready to send to: its stored settings plus decrypted secrets. */
export interface SendTarget {
	/** `id` is null for an unsaved channel being tested. */
	channel: Pick<AlertChannel, 'name' | 'kind' | 'config' | 'options'> & { id: string | null };
	secrets: Record<string, string>;
}

/**
 * Sends to one channel through its policy (routing, quiet hours, de-dupe, rate limit),
 * logging the attempt either way. Returns null when sent or suppressed, else the error.
 * The log row is written before the send, so concurrent alerts see it for limits.
 */
export async function sendTo(
	t: SendTarget,
	n: Notification,
	opts: { eventId?: number | null; persisted?: boolean; deps?: SendDeps; now?: Date } = {}
): Promise<{ status: 'sent' | 'failed' | 'suppressed'; detail: string | null }> {
	const at = opts.now ?? new Date();
	const key = dedupeKey(n);
	const base = {
		channel: t.channel,
		eventId: opts.eventId ?? null,
		event: n.event,
		severity: n.severity,
		title: n.title,
		connectionName: n.connection?.name ?? null,
		dedupeKey: key,
		at: at.getTime()
	};
	const recent = n.event === 'test' || !t.channel.id ? { lastHour: 0, lastSameAt: null } : recentDeliveries(t.channel.id, key, at.getTime());
	const decision = decide(t.channel.options, n, at, recent);
	if (!decision.send) {
		addDelivery({ ...base, status: 'suppressed', detail: decision.reason });
		return { status: 'suppressed', detail: decision.reason };
	}
	const logId = addDelivery({ ...base, status: 'sending' });
	const started = performance.now();
	try {
		await deliver(t.channel.kind, t.channel.config, t.secrets, n, opts.deps);
		finishDelivery(logId, 'sent', null, performance.now() - started);
		if (t.channel.id && opts.persisted !== false) recordDelivery(t.channel.id, null);
		return { status: 'sent', detail: null };
	} catch (err) {
		const message = (err as Error).message;
		finishDelivery(logId, 'failed', message, performance.now() - started);
		if (t.channel.id && opts.persisted !== false) recordDelivery(t.channel.id, message);
		return { status: 'failed', detail: message };
	}
}

/** Sends to every enabled channel; returns how many succeeded, were held back, and the errors. */
export async function broadcast(n: Notification, eventId: number | null = null, deps?: SendDeps): Promise<{ delivered: number; suppressed: number; errors: string[] }> {
	const channels = listChannels().filter((c) => c.enabled);
	const results = await Promise.all(
		channels.map(async (c) => {
			const full = channelWithSecrets(c.id);
			if (!full) return { status: 'suppressed' as const, detail: null, name: c.name };
			return { ...(await sendTo({ channel: full.channel, secrets: full.secrets }, n, { eventId, deps })), name: c.name };
		})
	);
	return {
		delivered: results.filter((r) => r.status === 'sent').length,
		suppressed: results.filter((r) => r.status === 'suppressed').length,
		errors: results.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.detail}`)
	};
}
