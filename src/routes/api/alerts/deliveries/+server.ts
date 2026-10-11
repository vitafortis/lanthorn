import { json } from '@sveltejs/kit';
import { handler } from '#lib/server/http.ts';
import { listDeliveries } from '#lib/server/alerts/store.ts';
import type { RequestHandler } from './$types';

/** Admins: the recent delivery log, newest first (paged with `before`, filtered by `channel`). */
export const GET: RequestHandler = handler(({ url }) => {
	const p = url.searchParams;
	return json(listDeliveries({ before: Number(p.get('before')) || undefined, limit: Number(p.get('limit')) || 50, channelId: p.get('channel') || undefined }));
});
