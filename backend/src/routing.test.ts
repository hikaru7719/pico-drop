import { test, expect, vi } from 'vitest';
import {
	authName,
	authRoute,
	loginRoute,
	roomRoute,
	routedToken,
	requestRate,
	clearPreviousChallenge
} from './routing.ts';
import { PasskeyAuth } from './auth.ts';
const secret = 'a'.repeat(64);
const request = (path: string, headers = {}) =>
	new Request('https://photos.example' + path, { headers });
const cookie = {
	Cookie: `__Host-pico_challenge=v2.ab.${secret}; __Host-pico_auth=v2.cd.${secret}`
};

test('challenge and login cookies select their own shards, preserving legacy cookies', () => {
	expect(authRoute(request('/api/auth/login/verify', cookie))).toBe('auth:ab');
	expect(authRoute(request('/api/auth/status', cookie))).toBe('auth:cd');
	expect(authName(secret)).toBe('mvp');
	expect(loginRoute('auth:login:v2.cd.hash')).toBe('auth:cd');
});
test('independent sessions get different rooms; invitations and sockets retain their room', () => {
	const room = roomRoute(request('/api/session'));
	expect(roomRoute(request('/api/session'))).not.toBe(room);
	expect(roomRoute(request('/api/session?room=' + room))).toBe(room);
	expect(roomRoute(request('/api/ws?room=' + room))).toBe(room);
});
for (const path of ['/api/ice', '/api/photos/convert', '/api/photos/discard']) {
	test(path + ' returns to the token issuer without a central registry', () => {
		const room = '1234567890abcdef';
		const token = routedToken(room);
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		expect(roomRoute(request(path, { Authorization: 'Bearer ' + token }))).toBe(
			room
		);
	});
}
class Namespace {
	names: string[] = [];
	limitRequest = vi.fn(async () => true);
	consumeCeremony = vi.fn(async () => undefined);
	env = {
		HUB: {
			idFromName: (name: string) => name,
			get: (name: string) => {
				this.names.push(name);
				return this;
			}
		}
	} as unknown as Env;
}
test('changing rooms cannot reset the IP rate limit', async () => {
	const app = new Namespace();
	for (const room of ['1111111111111111', '2222222222222222']) {
		await requestRate(app.env, request('/api/session?room=' + room), 'session');
	}
	expect(app.names[0]).toBe(app.names[1]);
	expect(app.names[0]).toMatch(/^rate:/);
});
test('new options invalidate the old challenge on its original shard', async () => {
	const app = new Namespace();
	await clearPreviousChallenge(
		app.env,
		request('/api/auth/login/options', cookie)
	);
	expect(app.names).toEqual(['auth:ab']);
	expect(app.consumeCeremony).toHaveBeenCalledOnce();
});
test('login lookup preserves the shard but stores only the secret hash', async () => {
	const auth = new PasskeyAuth({} as DurableObjectStorage, {});
	const key = await auth.loginKey(request('/', cookie));
	expect(key).toMatch(/^auth:login:v2\.cd\.[a-f0-9]{64}$/);
	expect(key).not.toContain(secret);
	expect(loginRoute(key)).toBe('auth:cd');
});
