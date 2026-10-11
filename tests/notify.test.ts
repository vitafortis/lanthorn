import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { buildRequest, deliver, matrixContent, redact, serviceError, subject, webhookPayload, secretHint, type Notification } from '../src/lib/server/alerts/notify.ts';
import { emailMessage, recipients, smtpOptions } from '../src/lib/server/alerts/email.ts';

const n: Notification = {
	event: 'fired',
	severity: 'critical',
	title: 'Database unreachable',
	message: 'Can’t connect: ECONNREFUSED',
	connection: { id: 'c1', name: 'nextcloud-db', engine: 'postgres' },
	rule: { id: 'r1', kind: 'unreachable' },
	value: null,
	since: '2026-10-09T10:00:00.000Z',
	at: '2026-10-09T10:01:00.000Z',
	url: 'https://pgm.lan/c/c1'
};

test('subject line', () => {
	assert.equal(subject(n), '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(subject({ ...n, event: 'resolved' }), '[RESOLVED] nextcloud-db: Database unreachable');
	assert.equal(subject({ ...n, event: 'test', connection: null, title: 'Test notification' }), '[TEST] Test notification');
});

test('ntfy: JSON publish to the server root with topic, priority and token', () => {
	const r = buildRequest('ntfy', { server: 'https://ntfy.example.com/', topic: 'dbs' }, { token: 'tk_abc' }, n);
	assert.equal(r.url, 'https://ntfy.example.com');
	assert.equal(r.headers.authorization, 'Bearer tk_abc');
	const body = JSON.parse(r.body);
	assert.equal(body.topic, 'dbs');
	assert.equal(body.priority, 5);
	assert.equal(body.click, 'https://pgm.lan/c/c1');
	assert.ok(body.tags.includes('rotating_light'));
	const resolved = JSON.parse(buildRequest('ntfy', { topic: 'dbs' }, {}, { ...n, event: 'resolved' }).body);
	assert.equal(resolved.priority, 3);
	assert.equal(buildRequest('ntfy', { topic: 'dbs' }, {}, n).headers.authorization, undefined);
});

test('gotify: /message with the app token header', () => {
	const r = buildRequest('gotify', { url: 'https://gotify.lan/' }, { token: 'AppTok' }, { ...n, severity: 'warning' });
	assert.equal(r.url, 'https://gotify.lan/message');
	assert.equal(r.headers['x-gotify-key'], 'AppTok');
	const body = JSON.parse(r.body);
	assert.equal(body.priority, 5);
	assert.equal(body.extras['client::notification'].click.url, 'https://pgm.lan/c/c1');
});

test('discord: an embed coloured by state', () => {
	const r = buildRequest('discord', {}, { url: 'https://discord.com/api/webhooks/1/x' }, n);
	assert.equal(r.url, 'https://discord.com/api/webhooks/1/x');
	const e = JSON.parse(r.body).embeds[0];
	assert.equal(e.title, '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(e.color, 0xef4444);
	assert.equal(e.timestamp, n.at);
	assert.equal(JSON.parse(buildRequest('discord', {}, { url: 'x' }, { ...n, event: 'resolved' }).body).embeds[0].color, 0x22c55e);
});

test('slack: Block Kit inside a coloured attachment, with a link button', () => {
	const body = JSON.parse(buildRequest('slack', { format: 'blocks' }, { url: 'https://hooks.slack.com/services/x' }, n).body);
	assert.equal(body.text, '[FIRING] nextcloud-db: Database unreachable');
	const [att] = body.attachments;
	assert.equal(att.color, '#ef4444');
	assert.equal(att.blocks[0].type, 'section');
	assert.match(att.blocks[0].text.text, /\*\[FIRING\] nextcloud-db: Database unreachable\*\nCan’t connect: ECONNREFUSED/);
	assert.equal(att.blocks[1].type, 'context');
	assert.match(att.blocks[1].elements[1].text, /^<!date\^\d+\^/);
	assert.equal(att.blocks[2].elements[0].url, 'https://pgm.lan/c/c1');
	// No public URL: no button. Mrkdwn control characters are escaped.
	const plain = JSON.parse(buildRequest('slack', {}, { url: 'x' }, { ...n, url: null, message: 'a <b> & c' }).body);
	assert.equal(plain.attachments[0].blocks.length, 2);
	assert.match(plain.attachments[0].blocks[0].text.text, /a &lt;b&gt; &amp; c/);
});

test('slack classic format: text plus a coloured attachment (Mattermost and friends)', () => {
	const body = JSON.parse(buildRequest('slack', { format: 'attachments' }, { url: 'https://hooks.slack.com/services/x' }, n).body);
	assert.equal(body.text, '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(body.attachments[0].color, '#ef4444');
	assert.equal(body.attachments[0].title_link, 'https://pgm.lan/c/c1');
	assert.equal(body.attachments[0].ts, Math.floor(Date.parse(n.at) / 1000));
});

test('generic webhook: documented JSON body and optional auth header', () => {
	const r = buildRequest('webhook', {}, { url: 'https://hook.lan/x', authorization: 'Bearer t' }, n);
	assert.equal(r.headers.authorization, 'Bearer t');
	assert.deepEqual(JSON.parse(r.body), webhookPayload(n));
	assert.deepEqual(Object.keys(webhookPayload(n)), ['source', 'version', 'event', 'severity', 'status', 'title', 'alert', 'message', 'rule', 'connection', 'value', 'since', 'at', 'url']);
	assert.equal(webhookPayload({ ...n, event: 'renotified' }).status, 'firing');
	assert.equal(webhookPayload({ ...n, event: 'resolved' }).status, 'resolved');
});

test('apprise: title/body/type, with an optional tag', () => {
	const body = JSON.parse(buildRequest('apprise', { tag: 'ops' }, { url: 'http://apprise:8000/notify/k' }, n).body);
	assert.equal(body.type, 'failure');
	assert.equal(body.tag, 'ops');
	assert.match(body.body, /ECONNREFUSED\nhttps:\/\/pgm\.lan\/c\/c1/);
	assert.equal(JSON.parse(buildRequest('apprise', {}, { url: 'x' }, { ...n, event: 'resolved' }).body).type, 'success');
});

test('secret hints reveal only the host', () => {
	assert.equal(secretHint('https://discord.com/api/webhooks/1/token'), 'discord.com/…');
	assert.equal(secretHint('tk_secret'), '••••••');
});

test('telegram: HTML message to the bot API, token only in the URL', () => {
	const r = buildRequest('telegram', { chatId: '-100123' }, { botToken: '123:ABC' }, { ...n, message: 'x < y' });
	assert.equal(r.url, 'https://api.telegram.org/bot123:ABC/sendMessage');
	const body = JSON.parse(r.body);
	assert.equal(body.chat_id, '-100123');
	assert.equal(body.parse_mode, 'HTML');
	assert.match(body.text, /<b>\[FIRING\] nextcloud-db: Database unreachable<\/b>\nx &lt; y/);
	assert.match(body.text, /<a href="https:\/\/pgm\.lan\/c\/c1">/);
	assert.ok(!r.body.includes('123:ABC'));
	assert.equal(buildRequest('telegram', { chatId: '1', apiUrl: 'http://tg.lan/' }, { botToken: 't' }, n).url, 'http://tg.lan/bott/sendMessage');
});

test('pushover: priority by state, optional device and sound', () => {
	const body = JSON.parse(buildRequest('pushover', { device: 'phone' }, { userKey: 'u', appToken: 'a' }, n).body);
	assert.equal(body.token, 'a');
	assert.equal(body.user, 'u');
	assert.equal(body.priority, 1);
	assert.equal(body.device, 'phone');
	assert.equal(body.url, 'https://pgm.lan/c/c1');
	assert.equal(body.sound, undefined);
	assert.equal(JSON.parse(buildRequest('pushover', {}, { userKey: 'u', appToken: 'a' }, { ...n, event: 'resolved' }).body).priority, -1);
	assert.equal(JSON.parse(buildRequest('pushover', {}, { userKey: 'u', appToken: 'a' }, { ...n, severity: 'warning' }).body).priority, 0);
});

test('home assistant: webhook gets the webhook payload; notify service gets title/message with a token', () => {
	const w = buildRequest('homeassistant', { url: 'http://ha.lan:8123/', mode: 'webhook' }, { webhookId: 'abc def' }, n);
	assert.equal(w.url, 'http://ha.lan:8123/api/webhook/abc%20def');
	assert.deepEqual(JSON.parse(w.body), webhookPayload(n));
	assert.equal(w.headers.authorization, undefined);
	const s = buildRequest('homeassistant', { url: 'http://ha.lan:8123', mode: 'service', service: 'notify.mobile_app_pixel' }, { token: 'llat' }, n);
	assert.equal(s.url, 'http://ha.lan:8123/api/services/notify/mobile_app_pixel');
	assert.equal(s.headers.authorization, 'Bearer llat');
	const body = JSON.parse(s.body);
	assert.equal(body.title, '[FIRING] nextcloud-db: Database unreachable');
	assert.equal(body.data.url, 'https://pgm.lan/c/c1');
	assert.equal(body.data.tag, 'pgm-r1-c1');
});

test('matrix: an HTML notice', () => {
	const c = matrixContent(n);
	assert.equal(c.msgtype, 'm.notice');
	assert.match(c.body, /^\[FIRING\] nextcloud-db: Database unreachable\n/);
	assert.match(c.formatted_body, /<b>.*Database unreachable<\/b><br>Can’t connect/);
});

test('email: SMTP options per encryption mode, recipients and the message', () => {
	assert.deepEqual(
		{ ...smtpOptions({ host: 'smtp.lan', security: 'tls' }, {}), tls: undefined },
		{ host: 'smtp.lan', port: 465, secure: true, requireTLS: false, ignoreTLS: false, tls: undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 }
	);
	const st = smtpOptions({ host: 'smtp.lan', username: 'me', verifyCert: 'skip' }, { password: 'pw' });
	assert.equal(st.port, 587);
	assert.equal(st.requireTLS, true);
	assert.equal(st.secure, false);
	assert.deepEqual(st.auth, { user: 'me', pass: 'pw' });
	assert.equal(st.tls.rejectUnauthorized, false);
	const none = smtpOptions({ host: 'smtp.lan', port: '25', security: 'none' }, {});
	assert.equal(none.ignoreTLS, true);
	assert.equal(none.port, 25);
	assert.equal(none.auth, undefined);
	assert.deepEqual(recipients('a@x.io, b@x.io;c@x.io'), ['a@x.io', 'b@x.io', 'c@x.io']);
	const m = emailMessage({ from: 'pgm <p@x.io>', to: 'a@x.io' }, { ...n, message: '<script>' }, subject(n));
	assert.equal(m.subject, '[FIRING] nextcloud-db: Database unreachable');
	assert.match(m.text, /^<script>\n\nStatus: Firing\nSeverity: critical\nConnection: nextcloud-db \(postgres\)/);
	assert.ok(m.html.includes('&lt;script&gt;') && !m.html.includes('<script>'));
});

test('service errors: the meaningful field of each service’s error body', () => {
	assert.equal(serviceError(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'), 'HTTP 400: Bad Request: chat not found');
	assert.equal(
		serviceError(400, '{"user":"invalid","errors":["user identifier is not a valid user, group, or subscribed user key"],"status":0}'),
		'HTTP 400: user identifier is not a valid user, group, or subscribed user key'
	);
	assert.equal(serviceError(403, '{"errcode":"M_FORBIDDEN","error":"User not in room"}'), 'HTTP 403: M_FORBIDDEN: User not in room');
	assert.equal(
		serviceError(401, '{"error":"Unauthorized","errorCode":401,"errorDescription":"you need to provide a valid access token"}'),
		'HTTP 401: you need to provide a valid access token'
	);
	assert.equal(serviceError(404, 'no_service'), 'HTTP 404: no_service');
	assert.equal(serviceError(500, ''), 'HTTP 500');
});

test('redact removes secret values from error messages', () => {
	assert.equal(redact('failed for https://x/bot123:SECRET/sendMessage', { botToken: '123:SECRET' }), 'failed for https://x/bot••••••/sendMessage');
	assert.equal(redact('a b', { short: 'a' }), 'a b');
});

/** A fake fetch that records requests and answers from a script. */
function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const f = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return answer(url, init);
	}) as unknown as typeof fetch;
	return { calls, deps: { fetch: f, timeoutMs: 2000 } };
}

test('deliver: Telegram and Pushover errors surface exactly, without the token', async () => {
	const tg = fakeFetch(() => new Response('{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}', { status: 403 }));
	await assert.rejects(deliver('telegram', { chatId: '1' }, { botToken: '999:TOKEN' }, n, tg.deps), { message: 'HTTP 403: Forbidden: bot was blocked by the user' });
	assert.equal(tg.calls[0].url, 'https://api.telegram.org/bot999:TOKEN/sendMessage');
	const ok200 = fakeFetch(() => new Response('{"status":0,"errors":["application token is invalid"]}', { status: 200 }));
	await assert.rejects(deliver('pushover', {}, { userKey: 'u', appToken: 'a' }, n, ok200.deps), /application token is invalid/);
	assert.equal(ok200.calls[0].url, 'https://api.pushover.net/1/messages.json');
	const down = fakeFetch(() => {
		throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9 for bot999:TOKEN' } });
	});
	await assert.rejects(deliver('telegram', { chatId: '1' }, { botToken: '999:TOKEN' }, n, down.deps), (err: Error) => {
		assert.match(err.message, /^connect ECONNREFUSED 127\.0\.0\.1:9/);
		assert.ok(!err.message.includes('999:TOKEN'));
		return true;
	});
	await assert.rejects(deliver('discord', {}, { url: 'file:///etc/passwd' }, n, down.deps), /no valid http\(s\) URL/);
	const fine = fakeFetch(() => new Response('ok'));
	await deliver('slack', { format: 'blocks' }, { url: 'https://hooks.slack.com/services/x' }, n, fine.deps);
	assert.equal(fine.calls[0].init.method, 'POST');
	assert.equal(fine.calls[0].init.redirect, 'error');
});

test('deliver: matrix resolves an alias, then PUTs the message', async () => {
	const m = fakeFetch((url) => (url.includes('/directory/room/') ? Response.json({ room_id: '!room:hs.lan' }) : Response.json({ event_id: '$e' })));
	await deliver('matrix', { homeserver: 'https://hs.lan/', room: '#alerts:hs.lan' }, { token: 'syt_x' }, n, m.deps);
	assert.equal(m.calls[0].url, 'https://hs.lan/_matrix/client/v3/directory/room/%23alerts%3Ahs.lan');
	assert.match(m.calls[1].url, /^https:\/\/hs\.lan\/_matrix\/client\/v3\/rooms\/!room%3Ahs\.lan\/send\/m\.room\.message\/pgm-/);
	assert.equal(m.calls[1].init.method, 'PUT');
	assert.equal((m.calls[1].init.headers as Record<string, string>).authorization, 'Bearer syt_x');
	const missing = fakeFetch(() => Response.json({ errcode: 'M_NOT_FOUND', error: 'Room alias not found' }, { status: 404 }));
	await assert.rejects(deliver('matrix', { homeserver: 'https://hs.lan', room: '#nope:hs.lan' }, { token: 't' }, n, missing.deps), {
		message: 'Room alias #nope:hs.lan: HTTP 404: M_NOT_FOUND: Room alias not found'
	});
});

test('deliver: against a local HTTP server (ntfy, gotify, webhook, home assistant), including a timeout', async () => {
	const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
			if (req.url === '/slow') return; // never answers
			if (req.url?.startsWith('/message') && req.headers['x-gotify-key'] !== 'good') {
				res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized","errorCode":401,"errorDescription":"you need to provide a valid access token"}');
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":1}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const deps = { fetch: globalThis.fetch, timeoutMs: 400 };
	try {
		await deliver('ntfy', { server: base, topic: 'dbs' }, { token: 'tk' }, n, deps);
		assert.equal(JSON.parse(seen.at(-1)!.body).topic, 'dbs');
		assert.equal(seen.at(-1)!.headers.authorization, 'Bearer tk');
		await assert.rejects(deliver('gotify', { url: base }, { token: 'bad' }, n, deps), { message: 'HTTP 401: you need to provide a valid access token' });
		await deliver('gotify', { url: base }, { token: 'good' }, n, deps);
		await deliver('webhook', {}, { url: `${base}/hook`, authorization: 'Bearer w' }, n, deps);
		assert.equal(JSON.parse(seen.at(-1)!.body).source, 'pg-modern');
		assert.equal(seen.at(-1)!.headers.authorization, 'Bearer w');
		await deliver('homeassistant', { url: base, mode: 'service', service: 'mobile_app_x' }, { token: 'llat' }, n, deps);
		assert.equal(seen.at(-1)!.url, '/api/services/notify/mobile_app_x');
		await assert.rejects(deliver('webhook', {}, { url: `${base}/slow` }, n, deps), { message: 'No answer within 0 s' });
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

/** A tiny local SMTP server: enough of the protocol for nodemailer, recording each message. */
async function fakeSmtp(opts: { auth?: 'accept' | 'reject' } = {}) {
	const mails: string[] = [];
	const server = net.createServer((sock) => {
		sock.setEncoding('utf8');
		let buf = '';
		let data: string | null = null;
		const send = (l: string) => sock.write(`${l}\r\n`);
		send('220 fake.smtp ESMTP');
		sock.on('data', (chunk: string) => {
			buf += chunk;
			let i: number;
			while ((i = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (data !== null) {
					if (line === '.') {
						mails.push(data);
						data = null;
						send('250 2.0.0 queued');
					} else data += `${line}\n`;
					continue;
				}
				const cmd = line.slice(0, 4).toUpperCase();
				if (cmd === 'EHLO') {
					const ext = ['fake.smtp', ...(opts.auth ? ['AUTH PLAIN LOGIN'] : [])];
					ext.forEach((e, j) => send(`250${j === ext.length - 1 ? ' ' : '-'}${e}`));
				} else if (cmd === 'HELO' || cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') send('250 OK');
				else if (cmd === 'AUTH') send(opts.auth === 'reject' ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
				else if (cmd === 'DATA') {
					data = '';
					send('354 End data with <CR><LF>.<CR><LF>');
				} else if (cmd === 'QUIT') {
					send('221 Bye');
					sock.end();
				} else send('502 5.5.2 Command not recognized');
			}
		});
		sock.on('error', () => {});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	return { mails, port: String((server.address() as AddressInfo).port), close: () => server.close() };
}

test('email: sends through a local SMTP server; auth and STARTTLS failures read like the server said', async () => {
	const deps = { fetch: globalThis.fetch, timeoutMs: 2000 };
	const ok = await fakeSmtp();
	try {
		await deliver('email', { host: '127.0.0.1', port: ok.port, security: 'none', from: 'pg·modern <alerts@x.io>', to: 'a@x.io, b@x.io' }, {}, n, deps);
		assert.equal(ok.mails.length, 1);
		assert.match(ok.mails[0], /^Subject: \[FIRING\] nextcloud-db: Database unreachable$/m);
		assert.match(ok.mails[0], /^To: a@x\.io, b@x\.io$/m);
		// STARTTLS required but not offered: refused rather than sent in the clear.
		await assert.rejects(deliver('email', { host: '127.0.0.1', port: ok.port, security: 'starttls', from: 'a@x.io', to: 'a@x.io' }, {}, n, deps), /STARTTLS|TLS/i);
		assert.equal(ok.mails.length, 1);
	} finally {
		ok.close();
	}
	const bad = await fakeSmtp({ auth: 'reject' });
	try {
		await assert.rejects(
			deliver('email', { host: '127.0.0.1', port: bad.port, security: 'none', username: 'me', from: 'a@x.io', to: 'a@x.io' }, { password: 'wrong-pass' }, n, deps),
			(err: Error) => {
				assert.match(err.message, /535 5\.7\.8 Authentication credentials invalid/);
				assert.ok(!err.message.includes('wrong-pass'));
				return true;
			}
		);
	} finally {
		bad.close();
	}
});
