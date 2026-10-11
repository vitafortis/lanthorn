/**
 * Notification channels. Every channel kind has an adapter with one job: send a
 * notification, or throw an Error whose message tells the admin exactly what went
 * wrong. HTTP channels are described by a pure `build` (what gets sent, tested
 * without a network); email goes through SMTP (email.ts). Outside services are
 * reached through `SendDeps`, so tests swap in local fakes.
 */
import type { AlertRuleKind, AlertTransition, ChannelKind, Severity } from '#lib/alerts.ts';
import { sendEmail, type MailerFactory } from './email.ts';

export interface Notification {
	event: AlertTransition | 'test';
	severity: Severity;
	/** e.g. "Database unreachable" */
	title: string;
	message: string;
	connection: { id: string; name: string; engine: string } | null;
	rule: { id: string; kind: AlertRuleKind } | null;
	value: number | null;
	/** When the alert started firing (ISO). */
	since: string | null;
	at: string;
	/** Link to the connection in pg·modern, when a public URL is configured. */
	url: string | null;
}

export interface OutgoingRequest {
	/** POST when absent. */
	method?: 'POST' | 'PUT';
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** What an adapter may use to reach the outside world. */
export interface SendDeps {
	fetch: typeof fetch;
	mailer?: MailerFactory;
	timeoutMs: number;
}

export interface ChannelAdapter {
	/** Sends `n`; throws an Error with the service's answer on failure. */
	send(config: Record<string, string>, secrets: Record<string, string>, n: Notification, deps: SendDeps): Promise<void>;
}

const LABEL: Record<Notification['event'], string> = {
	fired: 'FIRING',
	resolved: 'RESOLVED',
	renotified: 'STILL FIRING',
	test: 'TEST'
};

/** One-line subject, e.g. "[FIRING] nextcloud-db: Database unreachable". */
export function subject(n: Notification): string {
	return `[${LABEL[n.event]}] ${n.connection ? `${n.connection.name}: ` : ''}${n.title}`;
}

export type Tone = 'ok' | 'critical' | 'warning' | 'info';
export const tone = (n: Notification): Tone => (n.event === 'resolved' ? 'ok' : n.event === 'test' ? 'info' : n.severity);

const trimSlash = (s: string) => (s ?? '').replace(/\/+$/, '');
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMOJI: Record<Tone, string> = { ok: '✅', critical: '🔴', warning: '🟠', info: '🔔' };

/**
 * The JSON body POSTed to generic webhooks. Documented in the README; `version`
 * changes only if the shape does.
 */
export function webhookPayload(n: Notification) {
	return {
		source: 'pg-modern',
		version: 1,
		event: n.event,
		severity: n.severity,
		status: n.event === 'resolved' ? 'resolved' : n.event === 'test' ? 'test' : 'firing',
		title: subject(n),
		alert: n.title,
		message: n.message,
		rule: n.rule,
		connection: n.connection,
		value: n.value,
		since: n.since,
		at: n.at,
		url: n.url
	};
}

const DISCORD_COLORS = { ok: 0x22c55e, critical: 0xef4444, warning: 0xf59e0b, info: 0x8b5cf6 };
const SLACK_COLORS = { ok: '#22c55e', critical: '#ef4444', warning: '#f59e0b', info: '#8b5cf6' };
const json = { 'content-type': 'application/json' };

/** Slack mrkdwn needs only &, < and > escaped. */
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackBody(n: Notification, format: string | undefined) {
	const t = tone(n);
	const ts = Math.floor(new Date(n.at).getTime() / 1000);
	if (format === 'attachments') {
		// The classic shape Mattermost, Rocket.Chat and friends understand.
		return {
			text: subject(n),
			attachments: [
				{
					color: SLACK_COLORS[t],
					title: n.title,
					...(n.url ? { title_link: n.url } : {}),
					text: n.message,
					footer: n.connection ? `pg·modern · ${n.connection.name}` : 'pg·modern',
					ts
				}
			]
		};
	}
	const context = [n.connection ? `*${slackEscape(n.connection.name)}* · ${n.connection.engine}` : 'pg·modern', `<!date^${ts}^{date_short_pretty} {time}|${n.at}>`];
	const blocks: unknown[] = [
		{ type: 'section', text: { type: 'mrkdwn', text: `${EMOJI[t]} *${slackEscape(subject(n))}*\n${slackEscape(n.message).slice(0, 2900)}` } },
		{ type: 'context', elements: context.map((text) => ({ type: 'mrkdwn', text })) }
	];
	if (n.url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in pg·modern' }, url: n.url }] });
	// `text` is the push/fallback line; the coloured attachment carries the blocks.
	return { text: subject(n), attachments: [{ color: SLACK_COLORS[t], blocks }] };
}

export function telegramText(n: Notification): string {
	const lines = [`${EMOJI[tone(n)]} <b>${html(subject(n))}</b>`, html(n.message)];
	if (n.connection) lines.push(`<i>${html(n.connection.name)} · ${html(n.connection.engine)}</i>`);
	if (n.url) lines.push(`<a href="${html(n.url)}">Open in pg·modern</a>`);
	return lines.join('\n').slice(0, 4000);
}

export function matrixContent(n: Notification) {
	const plain = [subject(n), n.message, n.url ?? ''].filter(Boolean).join('\n');
	const rich = [`<b>${EMOJI[tone(n)]} ${html(subject(n))}</b>`, html(n.message), n.url ? `<a href="${html(n.url)}">Open in pg·modern</a>` : ''].filter(Boolean).join('<br>');
	return { msgtype: 'm.notice', body: plain, format: 'org.matrix.custom.html', formatted_body: rich };
}

/** The request each HTTP channel kind sends. Pure. */
export function buildRequest(kind: Exclude<ChannelKind, 'email' | 'matrix'>, config: Record<string, string>, secrets: Record<string, string>, n: Notification): OutgoingRequest {
	const t = tone(n);
	switch (kind) {
		case 'ntfy': {
			// JSON publishing: POST to the server root with the topic in the body.
			const headers: Record<string, string> = { ...json };
			if (secrets.token) headers.authorization = `Bearer ${secrets.token}`;
			return {
				url: trimSlash(config.server || 'https://ntfy.sh'),
				headers,
				body: JSON.stringify({
					topic: config.topic,
					title: subject(n),
					message: n.message,
					priority: t === 'critical' ? 5 : t === 'warning' ? 4 : 3,
					tags: [t === 'ok' ? 'white_check_mark' : t === 'critical' ? 'rotating_light' : t === 'warning' ? 'warning' : 'bell', 'pg-modern'],
					...(n.url ? { click: n.url } : {})
				})
			};
		}
		case 'gotify':
			return {
				url: `${trimSlash(config.url)}/message`,
				headers: { ...json, 'x-gotify-key': secrets.token ?? '' },
				body: JSON.stringify({
					title: subject(n),
					message: n.message,
					priority: t === 'critical' ? 8 : t === 'warning' ? 5 : 2,
					...(n.url ? { extras: { 'client::notification': { click: { url: n.url } } } } : {})
				})
			};
		case 'discord':
			return {
				url: secrets.url,
				headers: json,
				body: JSON.stringify({
					username: 'pg·modern',
					embeds: [
						{
							title: subject(n).slice(0, 256),
							description: n.message.slice(0, 4000),
							color: DISCORD_COLORS[t],
							timestamp: n.at,
							...(n.url ? { url: n.url } : {}),
							...(n.connection ? { footer: { text: `${n.connection.name} · ${n.connection.engine}` } } : {})
						}
					]
				})
			};
		case 'slack':
			return { url: secrets.url, headers: json, body: JSON.stringify(slackBody(n, config.format)) };
		case 'telegram':
			return {
				url: `${trimSlash(config.apiUrl || 'https://api.telegram.org')}/bot${secrets.botToken}/sendMessage`,
				headers: json,
				body: JSON.stringify({ chat_id: config.chatId, text: telegramText(n), parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
			};
		case 'pushover':
			return {
				url: 'https://api.pushover.net/1/messages.json',
				headers: json,
				body: JSON.stringify({
					token: secrets.appToken,
					user: secrets.userKey,
					title: subject(n).slice(0, 250),
					message: n.message.slice(0, 1024),
					priority: t === 'critical' ? 1 : t === 'ok' ? -1 : 0,
					timestamp: Math.floor(new Date(n.at).getTime() / 1000),
					...(n.url ? { url: n.url, url_title: 'Open in pg·modern' } : {}),
					...(config.device ? { device: config.device } : {}),
					...(config.sound ? { sound: config.sound } : {})
				})
			};
		case 'homeassistant': {
			const base = trimSlash(config.url);
			if ((config.mode || 'webhook') === 'webhook') {
				return { url: `${base}/api/webhook/${encodeURIComponent(secrets.webhookId ?? '')}`, headers: json, body: JSON.stringify(webhookPayload(n)) };
			}
			const service = (config.service ?? '').replace(/^notify\./, '');
			return {
				url: `${base}/api/services/notify/${encodeURIComponent(service)}`,
				headers: { ...json, authorization: `Bearer ${secrets.token ?? ''}` },
				body: JSON.stringify({
					title: subject(n),
					message: n.message,
					data: {
						tag: n.rule && n.connection ? `pgm-${n.rule.id}-${n.connection.id}` : 'pgm-test',
						group: 'pg-modern',
						...(n.url ? { url: n.url, clickAction: n.url } : {})
					}
				})
			};
		}
		case 'webhook': {
			const headers: Record<string, string> = { ...json, 'user-agent': 'pg-modern' };
			if (secrets.authorization) headers.authorization = secrets.authorization;
			return { url: secrets.url, headers, body: JSON.stringify(webhookPayload(n)) };
		}
		case 'apprise':
			return {
				url: secrets.url,
				headers: json,
				body: JSON.stringify({
					title: subject(n),
					body: n.url ? `${n.message}\n${n.url}` : n.message,
					type: t === 'ok' ? 'success' : t === 'critical' ? 'failure' : t === 'warning' ? 'warning' : 'info',
					...(config.tag ? { tag: config.tag } : {})
				})
			};
	}
}

/** Turns a service's error body into something readable: the JSON error field, else the text. */
export function serviceError(status: number, text: string): string {
	let detail = text.replace(/\s+/g, ' ').trim();
	try {
		const j = JSON.parse(text) as Record<string, unknown>;
		const pick =
			(typeof j.description === 'string' && j.description) || // Telegram
			(Array.isArray(j.errors) && j.errors.map(String).join('; ')) || // Pushover
			(typeof j.errorDescription === 'string' && j.errorDescription) || // Gotify
			(typeof j.error === 'string' && (typeof j.errcode === 'string' ? `${j.errcode}: ${j.error}` : j.error)) || // Matrix, ntfy
			(typeof j.message === 'string' && j.message); // Home Assistant, Discord
		if (pick) detail = pick;
	} catch {
		// not JSON
	}
	return `HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
}

async function request(req: OutgoingRequest, deps: SendDeps): Promise<Response> {
	if (!/^https?:\/\//i.test(req.url ?? '')) throw new Error('The channel has no valid http(s) URL');
	let res: Response;
	try {
		res = await deps.fetch(req.url, {
			method: req.method ?? 'POST',
			headers: req.headers,
			body: req.body,
			signal: AbortSignal.timeout(deps.timeoutMs),
			redirect: 'error'
		});
	} catch (err) {
		throw new Error(networkError(err, deps.timeoutMs));
	}
	if (!res.ok) throw new Error(serviceError(res.status, await res.text().catch(() => '')));
	return res;
}

function networkError(err: unknown, timeoutMs: number): string {
	const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
	if (e.name === 'TimeoutError' || e.name === 'AbortError') return `No answer within ${Math.round(timeoutMs / 1000)} s`;
	const c = e.cause;
	if (c?.code && c.message && !c.message.includes(c.code)) return `${c.code}: ${c.message}`;
	return c?.message ?? c?.code ?? e.message ?? String(err);
}

const http = (build: (config: Record<string, string>, secrets: Record<string, string>, n: Notification) => OutgoingRequest): ChannelAdapter => ({
	async send(config, secrets, n, deps) {
		const res = await request(build(config, secrets, n), deps);
		// Telegram and Pushover answer 200 with { ok: false } / { status: 0 } in rare cases.
		const body = (await res.text().catch(() => '')).trim();
		let j: { ok?: boolean; status?: number } | null = null;
		try {
			j = body.startsWith('{') ? JSON.parse(body) : null;
		} catch {
			// not JSON: a 2xx is success
		}
		if (j && (j.ok === false || j.status === 0)) throw new Error(serviceError(res.status, body));
	}
});

const matrix: ChannelAdapter = {
	async send(config, secrets, n, deps) {
		const hs = trimSlash(config.homeserver);
		const auth = { authorization: `Bearer ${secrets.token ?? ''}` };
		let room = (config.room ?? '').trim();
		if (room.startsWith('#')) {
			if (!/^https?:\/\//i.test(hs)) throw new Error('The channel has no valid http(s) URL');
			let res: Response;
			try {
				res = await deps.fetch(`${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(room)}`, { headers: auth, signal: AbortSignal.timeout(deps.timeoutMs), redirect: 'error' });
			} catch (err) {
				throw new Error(networkError(err, deps.timeoutMs));
			}
			if (!res.ok) throw new Error(`Room alias ${room}: ${serviceError(res.status, await res.text().catch(() => ''))}`);
			room = String(((await res.json()) as { room_id?: string }).room_id ?? '');
			if (!room) throw new Error('Room alias did not resolve to a room ID');
		}
		const txn = `pgm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
		await request(
			{
				method: 'PUT',
				url: `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`,
				headers: { ...json, ...auth },
				body: JSON.stringify(matrixContent(n))
			},
			deps
		);
	}
};

const email: ChannelAdapter = {
	send: (config, secrets, n, deps) => sendEmail(config, secrets, n, deps, subject(n))
};

export const ADAPTERS: Record<ChannelKind, ChannelAdapter> = {
	slack: http((c, s, n) => buildRequest('slack', c, s, n)),
	discord: http((c, s, n) => buildRequest('discord', c, s, n)),
	telegram: http((c, s, n) => buildRequest('telegram', c, s, n)),
	pushover: http((c, s, n) => buildRequest('pushover', c, s, n)),
	gotify: http((c, s, n) => buildRequest('gotify', c, s, n)),
	ntfy: http((c, s, n) => buildRequest('ntfy', c, s, n)),
	homeassistant: http((c, s, n) => buildRequest('homeassistant', c, s, n)),
	webhook: http((c, s, n) => buildRequest('webhook', c, s, n)),
	apprise: http((c, s, n) => buildRequest('apprise', c, s, n)),
	matrix,
	email
};

export const defaultDeps = (): SendDeps => ({ fetch: globalThis.fetch, timeoutMs: 10_000 });

/** Replaces any secret value that appears in a message (e.g. a token echoed in a URL). */
export function redact(message: string, secrets: Record<string, string>): string {
	let out = message;
	for (const v of Object.values(secrets)) if (v && v.length >= 4) out = out.split(v).join('••••••');
	return out;
}

/** Sends a notification; throws with the service's answer (secrets removed) on failure. */
export async function deliver(
	kind: ChannelKind,
	config: Record<string, string>,
	secrets: Record<string, string>,
	n: Notification,
	deps: SendDeps = defaultDeps()
): Promise<void> {
	try {
		await ADAPTERS[kind].send(config, secrets, n, deps);
	} catch (err) {
		throw new Error(redact((err as Error).message || String(err), secrets));
	}
}

/** A safe-to-show hint for a secret: the host of a URL, or that a token is set. */
export function secretHint(value: string): string {
	try {
		const u = new URL(value);
		if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.host}/…`;
	} catch {
		// not a URL
	}
	return '••••••';
}
