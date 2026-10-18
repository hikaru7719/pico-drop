import { test, expect, vi } from 'vitest';
import { createApp, type ApiGateway } from './app.ts';
const origin = 'https://photos.example';
const room = '1234567890abcdef';
class Fixture {
	response = new Response('forwarded');
	fetch = vi.fn(async (_request: Request) => this.response);
	consumePhoto = vi.fn(async () => null);
	revokePhoto = vi.fn(async () => {});
	gateway = {
		hub: vi.fn(() => this),
		rate: vi.fn(async () => true),
		clearChallenge: vi.fn(async () => {}),
		images: { render: vi.fn() }
	} satisfies ApiGateway;
	app = createApp(() => this.gateway);
	request(path: string, method = 'POST', headers: Record<string, string> = {}) {
		return this.app.request(origin + path, {
			method,
			headers: { Origin: origin, ...headers }
		});
	}
}
test('health is available without Origin or gateway access', async () => {
	const gateway = vi.fn();
	const response = await createApp(gateway).request(origin + '/api/health');
	expect(await response.json()).toEqual({
		status: 'ok',
		service: 'pico-drop-backend'
	});
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	expect(gateway).not.toHaveBeenCalled();
});
test.each(['', 'https://other.example'])(
	'rejects Origin %s before routing or rate limiting',
	async (Origin) => {
		const fixture = new Fixture();
		expect(
			(await fixture.request('/api/session', 'POST', { Origin })).status
		).toBe(403);
		expect(fixture.gateway.hub).not.toHaveBeenCalled();
		expect(fixture.gateway.rate).not.toHaveBeenCalled();
	}
);
test.each([
	'/api/session',
	'/api/ice',
	'/api/photos/convert',
	'/api/photos/discard',
	'/api/auth/status'
])('rejects unsupported methods on %s', async (path) => {
	const fixture = new Fixture();
	expect((await fixture.request(path, 'GET')).status).toBe(405);
	expect(fixture.fetch).not.toHaveBeenCalled();
});
test.each(['/missing', '/api/session/', '/api/photos/missing', '/api/auth'])(
	'unknown path %s is not forwarded',
	async (path) => {
		const fixture = new Fixture();
		expect((await fixture.request(path)).status).toBe(404);
		expect(fixture.fetch).not.toHaveBeenCalled();
	}
);
test('session routing keeps the room and uses the IP quota', async () => {
	const fixture = new Fixture();
	await fixture.request('/api/session?room=' + room, 'POST', {
		'CF-Connecting-IP': '192.0.2.1'
	});
	expect(fixture.gateway.rate).toHaveBeenCalledWith('192.0.2.1', 'session');
	expect(fixture.gateway.hub).toHaveBeenCalledWith('room:' + room);
	expect(forwardedRoom(fixture)).toBe(room);
});
test('new sessions get a generated room', async () => {
	const fixture = new Fixture();
	await fixture.request('/api/session');
	expect(fixture.gateway.hub).toHaveBeenCalledWith(
		expect.stringMatching(/^room:[a-f0-9]{16}$/)
	);
});
test('session rate limit stops forwarding', async () => {
	const fixture = new Fixture();
	vi.mocked(fixture.gateway.rate).mockResolvedValue(false);
	expect((await fixture.request('/api/session')).status).toBe(429);
	expect(fixture.fetch).not.toHaveBeenCalled();
});
test.each([
	'/api/ws',
	'/api/session?room=bad',
	'/api/ice',
	'/api/photos/convert'
])('invalid room on %s never reaches a hub', async (path) => {
	const fixture = new Fixture();
	expect((await fixture.request(path)).status).toBe(400);
	expect(fixture.gateway.hub).not.toHaveBeenCalled();
});
test('auth routing replaces untrusted routing headers and preserves cookies', async () => {
	const fixture = new Fixture();
	const Cookie = '__Host-pico_auth=v2.ab.' + 'a'.repeat(64);
	await authStatus(fixture, Cookie);
	expect(fixture.gateway.hub).toHaveBeenCalledWith('auth:ab');
	expect(forwardedHeader(fixture, 'X-Auth-Route')).toBe('auth:ab');
	expect(forwardedHeader(fixture, 'Cookie')).toBe(Cookie);
});
test.each(['status', 'logout'])(
	'auth %s bypasses the login attempt quota',
	async (action) => {
		const fixture = new Fixture();
		await fixture.request('/api/auth/' + action);
		expect(fixture.gateway.rate).not.toHaveBeenCalled();
		expect(fixture.gateway.clearChallenge).not.toHaveBeenCalled();
	}
);
test('auth rate limits do not invalidate a previous ceremony', async () => {
	const fixture = new Fixture();
	vi.mocked(fixture.gateway.rate).mockResolvedValue(false);
	expect((await fixture.request('/api/auth/login/options')).status).toBe(429);
	expect(fixture.gateway.clearChallenge).not.toHaveBeenCalled();
	expect(fixture.fetch).not.toHaveBeenCalled();
});
test('new options invalidate an existing challenge before forwarding', async () => {
	const fixture = new Fixture();
	const token = 'v2.cd.' + 'a'.repeat(64);
	await fixture.request('/api/auth/login/options', 'POST', {
		Cookie: '__Host-pico_challenge=' + token
	});
	expect(fixture.gateway.clearChallenge).toHaveBeenCalledWith(token);
	expectRandomAuth(fixture);
});
test('verification leaves challenge consumption to its original shard', async () => {
	const fixture = new Fixture();
	await fixture.request('/api/auth/login/verify', 'POST', {
		Cookie: '__Host-pico_challenge=v2.cd.' + 'a'.repeat(64)
	});
	expect(fixture.gateway.hub).toHaveBeenCalledWith('auth:cd');
	expect(fixture.gateway.clearChallenge).not.toHaveBeenCalled();
});
test('socket forwarding returns the original response including upgrade metadata', async () => {
	const fixture = new Fixture();
	markUpgrade(fixture);
	const response = await fixture.request('/api/ws?room=' + room, 'GET', {
		Upgrade: 'websocket'
	});
	expect(response).toBe(fixture.response);
	expect(response.webSocket).toBe(fixture.response.webSocket);
	expect(forwardedHeader(fixture, 'Upgrade')).toBe('websocket');
});
test('photo discard resolves the token issuer and revokes through RPC', async () => {
	const fixture = new Fixture();
	const token = room + 'a'.repeat(48);
	const response = await discardRequest(fixture, token);
	expect(response.status).toBe(204);
	expect(fixture.gateway.hub).toHaveBeenCalledWith('room:' + room);
	expect(fixture.revokePhoto).toHaveBeenCalledWith(token);
	expect(fixture.fetch).not.toHaveBeenCalled();
});
test('unexpected failures return an uncached JSON error without internal details', async () => {
	const fixture = new Fixture();
	fixture.fetch.mockRejectedValue(new Error('private details'));
	const response = await fixture.request('/api/auth/status');
	expect(response.status).toBe(500);
	expect(await response.json()).toEqual({ error: 'Internal server error' });
	expect(response.headers.get('Cache-Control')).toBe('no-store');
});

function forwardedRoom(fixture: Fixture) {
	return new URL(fixture.fetch.mock.calls[0][0].url).searchParams.get('room');
}
function forwardedHeader(fixture: Fixture, name: string) {
	return fixture.fetch.mock.calls[0][0].headers.get(name);
}
function expectRandomAuth(fixture: Fixture) {
	expect(fixture.gateway.hub).toHaveBeenCalledWith(
		expect.stringMatching(/^auth:[a-f0-9]{2}$/)
	);
}
function markUpgrade(fixture: Fixture) {
	Object.defineProperty(fixture.response, 'webSocket', { value: {} });
}
function discardRequest(fixture: Fixture, token: string) {
	return fixture.request('/api/photos/discard', 'POST', {
		Authorization: 'Bearer ' + token
	});
}

function authStatus(fixture: Fixture, Cookie: string) {
	return fixture.request('/api/auth/status', 'POST', {
		Cookie,
		'X-Auth-Route': 'mvp'
	});
}
