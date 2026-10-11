/** The email channel: SMTP through nodemailer, with implicit TLS, STARTTLS or neither. */
import nodemailer from 'nodemailer';
import type { Notification, SendDeps } from './notify.ts';

export interface SmtpOptions {
	host: string;
	port: number;
	/** Implicit TLS from the first byte (465). */
	secure: boolean;
	/** Refuse to send unless the server upgrades with STARTTLS. */
	requireTLS: boolean;
	/** Never try STARTTLS. */
	ignoreTLS: boolean;
	auth?: { user: string; pass: string };
	tls: { rejectUnauthorized: boolean; servername?: string };
	connectionTimeout: number;
	greetingTimeout: number;
	socketTimeout: number;
}

export interface MailMessage {
	from: string;
	to: string[];
	subject: string;
	text: string;
	html: string;
}

export type MailerFactory = (opts: SmtpOptions) => { sendMail(msg: MailMessage): Promise<unknown>; close?(): void };

const defaultMailer: MailerFactory = (opts) => nodemailer.createTransport(opts);

/** SMTP transport options from a channel's settings. Pure. */
export function smtpOptions(config: Record<string, string>, secrets: Record<string, string>, timeoutMs = 10_000): SmtpOptions {
	const security = config.security || 'starttls';
	const port = Number(config.port) || (security === 'tls' ? 465 : 587);
	return {
		host: config.host,
		port,
		secure: security === 'tls',
		requireTLS: security === 'starttls',
		ignoreTLS: security === 'none',
		...(config.username ? { auth: { user: config.username, pass: secrets.password ?? '' } } : {}),
		tls: { rejectUnauthorized: config.verifyCert !== 'skip' },
		connectionTimeout: timeoutMs,
		greetingTimeout: timeoutMs,
		socketTimeout: timeoutMs * 2
	};
}

export const recipients = (to: string | undefined) =>
	(to ?? '')
		.split(/[,;\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LABEL = { fired: 'Firing', resolved: 'Resolved', renotified: 'Still firing', test: 'Test' };

export function emailMessage(config: Record<string, string>, n: Notification, subjectLine: string): MailMessage {
	const rows: [string, string][] = [['Status', LABEL[n.event]], ['Severity', n.severity]];
	if (n.connection) rows.push(['Connection', `${n.connection.name} (${n.connection.engine})`]);
	if (n.since) rows.push(['Since', n.since]);
	rows.push(['At', n.at]);
	const text = [n.message, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(n.url ? ['', n.url] : []), '', '— pg·modern'].join('\n');
	const htmlBody = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
<p style="margin:0 0 12px">${esc(n.message)}</p>
<table style="border-collapse:collapse;font-size:13px">${rows.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#71717a">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
${n.url ? `<p style="margin:12px 0 0"><a href="${esc(n.url)}">Open in pg·modern</a></p>` : ''}
<p style="margin:16px 0 0;color:#a1a1aa;font-size:12px">Sent by pg·modern</p></div>`;
	return { from: config.from, to: recipients(config.to), subject: subjectLine, text, html: htmlBody };
}

/** Sends one email; nodemailer's error (with the SMTP reply) is passed through. */
export async function sendEmail(
	config: Record<string, string>,
	secrets: Record<string, string>,
	n: Notification,
	deps: SendDeps,
	subjectLine: string
): Promise<void> {
	if (!config.host) throw new Error('No SMTP host');
	const msg = emailMessage(config, n, subjectLine);
	if (!msg.to.length) throw new Error('No recipient');
	const transport = (deps.mailer ?? defaultMailer)(smtpOptions(config, secrets, deps.timeoutMs));
	try {
		await transport.sendMail(msg);
	} catch (err) {
		const e = err as { code?: string; message?: string };
		const m = e.message ?? String(err);
		throw new Error(e.code && !m.includes(e.code) ? `${e.code}: ${m}` : m);
	} finally {
		transport.close?.();
	}
}
