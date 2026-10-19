import { env } from 'cloudflare:workers';
import type { RequestHandler } from './$types';

const proxy: RequestHandler = async ({ request }) => {
	if (!env.BACKEND) {
		return Response.json({ error: 'サーバーに接続できません。時間をおいてお試しください。' }, { status: 503 });
	}
	return env.BACKEND.fetch(request);
};

export const GET = proxy;
export const POST = proxy;
