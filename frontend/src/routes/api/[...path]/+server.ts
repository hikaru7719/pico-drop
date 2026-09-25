import type { RequestHandler } from './$types';
const proxy: RequestHandler = async ({ request, platform }) => {
	if (!platform?.env.BACKEND) return new Response('Backend unavailable', { status: 503 });
	return platform.env.BACKEND.fetch(request);
};
export const GET = proxy;
export const POST = proxy;
