import { json } from '@sveltejs/kit';
import { BadRequest, handler } from '#lib/server/http.ts';
import { audit } from '#lib/server/permissions.ts';
import { getChannel, missingFields, resolveChannelInput } from '#lib/server/alerts/store.ts';
import { parseChannelInput } from '#lib/server/alerts/input.ts';
import { notificationFor, sendTo } from '#lib/server/alerts/dispatch.ts';
import type { RequestHandler } from './$types';

/**
 * Sends a test notification with the form's values; blank secret fields fall back to
 * the stored channel's (`id`), so a saved channel can be tested without retyping them.
 * Answers 200 either way, with the service's exact error when it failed; the attempt
 * goes into the delivery log.
 */
export const POST: RequestHandler = handler(async ({ request, locals }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const id = typeof body?.id === 'string' && getChannel(body.id) ? body.id : undefined;
	const input = parseChannelInput(body, id ? getChannel(id)!.options : undefined);
	const { config, secrets } = resolveChannelInput(input, id);
	const missing = missingFields(input.kind, config, secrets);
	if (missing.length) throw new BadRequest(`Missing: ${missing.join(', ')}`);
	const n = notificationFor(null, null, 'test', `Test notification from pg·modern, sent by ${locals.user?.email ?? 'an admin'}. Alerts arrive like this.`);
	audit(locals, 'alerts.channel.test', { detail: input.name });
	const started = performance.now();
	const r = await sendTo({ channel: { id: id ?? null, name: input.name, kind: input.kind, config, options: input.options }, secrets }, n);
	const ms = Math.round(performance.now() - started);
	return json(r.status === 'sent' ? { ok: true, ms } : { ok: false, error: r.detail ?? 'Not sent', ms });
});
