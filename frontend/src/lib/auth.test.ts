import { afterEach, expect, expectTypeOf, test, vi } from 'vitest';
import { authApi } from './auth';
import { api } from './api';
import type { InferRequestType, InferResponseType } from 'hono/client';

afterEach(() => vi.restoreAllMocks());

const registration = {
	id: 'credential',
	rawId: 'credential',
	type: 'public-key' as const,
	response: { clientDataJSON: 'client', attestationObject: 'attestation' },
	clientExtensionResults: {}
};
const authentication = {
	id: 'credential',
	rawId: 'credential',
	type: 'public-key' as const,
	response: {
		clientDataJSON: 'client',
		authenticatorData: 'authenticator',
		signature: 'signature'
	},
	clientExtensionResults: {}
};
const calls = [
	{ path: 'status', call: () => authApi.status() },
	{ path: 'logout', call: () => authApi.logout() },
	{ path: 'login/options', call: () => authApi.loginOptions() },
	{
		path: 'register/options',
		call: () => authApi.registerOptions('写真 太郎'),
		body: { name: '写真 太郎' }
	},
	{
		path: 'register/verify',
		call: () => authApi.registerVerify(registration),
		body: registration
	},
	{
		path: 'login/verify',
		call: () => authApi.loginVerify(authentication),
		body: authentication
	}
];
test.each(calls)(
	'RPC sends auth/$path with the expected JSON body',
	async ({ path, call, body }) => {
		const result = { account: { name: '写真 太郎' } };
		const request = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(Response.json(result));
		expect(await call()).toEqual(result);
		expect(request).toHaveBeenCalledOnce();
		const [url, init] = request.mock.calls[0];
		assertAuthRequest({ url, init, path, body });
	}
);
test.each([{ error: '認証の試行が多すぎます。' }, {}])(
	'RPC preserves auth error messages: %j',
	async (body) => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json(body, { status: 429 })
		);
		await expect(authApi.status()).rejects.toThrow(
			body.error ?? '認証できませんでした。'
		);
	}
);
test('RPC preserves network failures', async () => {
	vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
	await expect(authApi.status()).rejects.toThrow('offline');
});

test.each([
	'Backend unavailable',
	'<html>Bad Gateway</html>',
	'',
	'null',
	'{"error":42}'
])('RPC falls back for an invalid error response: %s', async (body) => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(body, { status: 503 })
	);
	await expect(authApi.status()).rejects.toThrow('認証できませんでした。');
});

test('RPC infers auth input and account response from the backend', () => {
	expectTypeOf<
		InferRequestType<typeof api.auth.register.options.$post>
	>().toEqualTypeOf<{ json: { name: string } }>();
	expectTypeOf<
		InferResponseType<typeof api.auth.status.$post>
	>().toEqualTypeOf<{ account: { name: string } | null }>();
});

type AuthRequest = {
	url: unknown;
	init?: RequestInit;
	path: string;
	body?: unknown;
};

function assertAuthRequest({ url, init, path, body }: AuthRequest) {
	expect(url).toBe('/api/auth/' + path);
	expect(init?.method).toBe('POST');
	expect(init?.body).toBe(body ? JSON.stringify(body) : undefined);
	expect(new Headers(init?.headers).get('Content-Type')).toBe(
		body ? 'application/json' : null
	);
}
