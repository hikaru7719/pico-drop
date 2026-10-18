import { test, expect, vi } from 'vitest';
import { roomApp } from './room.ts';
import { ServiceError } from '../application/errors.ts';
const origin = 'https://photos.example';
function fixture() {
	const service = {
		createSession: vi.fn(async () => ({ token: 'token' })),
		ice: vi.fn(async () => ({ iceServers: [] }))
	};
	const upgrade = vi.fn(async () => new Response('upgrade'));
	return { service, upgrade, app: roomApp(service as never, upgrade) };
}
test('session HTTP adapter returns 201 and only passes the hashed login key', async () => {
	const { app, service } = fixture();
	const response = await sessionRequest(app);
	expect(response.status).toBe(201);
	expect(service.createSession).toHaveBeenCalledWith({
		room: 'abc',
		authKey: expect.stringMatching(/^auth:login:v2\.ab\.[a-f0-9]{64}$/)
	});
	expect(await response.json()).toEqual({ token: 'token' });
});
test('anonymous session and ICE adapter preserve their input defaults', async () => {
	const { app, service } = fixture();
	await app.request(origin + '/api/session', { method: 'POST' });
	expect(service.createSession).toHaveBeenCalledWith({
		room: undefined,
		authKey: ''
	});
	await iceRequest(app);
	expect(service.ice).toHaveBeenCalledWith('token');
});
test.each(['/api/session', '/api/ws', '/missing'])(
	'room adapter rejects unsupported request %s',
	async (path) => {
		expect((await fixture().app.request(origin + path)).status).toBe(405);
	}
);
test('websocket upgrades are returned without modifying their response', async () => {
	const { app, upgrade } = fixture();
	const response = await app.request(origin + '/api/ws', {
		headers: { Upgrade: 'WebSocket' }
	});
	expect(response).toBe(await upgrade.mock.results[0].value);
});
test.each([
	['unauthorized', 401],
	['forbidden', 403],
	['rate-limit', 429],
	['unavailable', 503]
] as const)('maps %s application failures to HTTP', async (code, status) => {
	const { app, service } = fixture();
	service.ice.mockRejectedValue(new ServiceError(code, 'message'));
	const response = await app.request(origin + '/api/ice', { method: 'POST' });
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ error: 'message' });
	expect(response.headers.get('Cache-Control')).toBe('no-store');
});

type RoomApp = ReturnType<typeof roomApp>;
function sessionRequest(app: RoomApp) {
	return app.request(origin + '/api/session?room=abc', {
		method: 'POST',
		headers: { Cookie: '__Host-pico_auth=v2.ab.' + 'a'.repeat(64) }
	});
}
function iceRequest(app: RoomApp) {
	return app.request(origin + '/api/ice', {
		method: 'POST',
		headers: { Authorization: 'Bearer token' }
	});
}
