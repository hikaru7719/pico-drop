// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { GET, POST } from './+server';

const backendFetch = vi.hoisted(() => vi.fn());

vi.mock('cloudflare:workers', () => ({
	env: { BACKEND: { fetch: backendFetch } }
}));

const backend = env.BACKEND;
const unavailable = 'サーバーに接続できません。時間をおいてお試しください。';
const response = Response.json({ account: null }, { headers: { 'Set-Cookie': 'session=value' } });

afterEach(() => {
	env.BACKEND = backend;
	vi.resetAllMocks();
});

test.each(['GET', 'POST'] as const)('proxy forwards %s without event.platform', async (method) => {
	const handler = { GET, POST }[method];
	const request = new Request('https://pico.test/api/auth/status', {
		method
	});
	backendFetch.mockResolvedValue(response);
	const result = await handler({ request } as Parameters<typeof handler>[0]);
	expect(result).toBe(response);
	expect(backendFetch).toHaveBeenCalledExactlyOnceWith(request);
});

test('missing backend returns a JSON error', async () => {
	env.BACKEND = undefined as unknown as typeof env.BACKEND;
	const result = await POST({} as Parameters<typeof POST>[0]);
	expect(result.status).toBe(503);
	expect(await result.json()).toEqual({ error: unavailable });
});
