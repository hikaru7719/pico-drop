import { test, expect, vi } from 'vitest';
import {
	accountRoute,
	network,
	identity,
	allowSend,
	type AuthHub,
	loginRoute,
	requestRate,
	clearPreviousChallenge
} from './hub-network.ts';
import { PasskeyAuth } from '../api/auth.ts';
import type { AuthStore } from '../application/auth.ts';
import { passkeys } from './passkeys.ts';
import { authName, routedToken } from '../domain/tokens.ts';
import { authRoute, roomRoute } from '../api/routing.ts';
const secret = 'a'.repeat(64);

const request = (path: string, headers = {}) => new Request('https://photos.example' + path, { headers });

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
		expect(roomRoute(request(path, { Authorization: 'Bearer ' + token }))).toBe(room);
	});
}
class Namespace implements AuthHub {
	names: string[] = [];
	limitRequest = vi.fn(async () => true);
	verifyAccountLogin = vi.fn(async () => ({ id: 'v2.ab.user', name: 'Guest' }));
	issueAccountLogin = vi.fn(async () => 'token');
	revokeLogin = vi.fn(async () => {});
	accountIdentity = vi.fn(async () => ({ id: 'user', name: 'Guest' }));
	authorizeSend = vi.fn(async () => ({ id: 'user', name: 'Guest' }));
	consumeCeremony = vi.fn(async () => undefined);
	env = {
		HUB: {
			idFromName: (name: string) => name,
			get: (name: string) => {
				this.names.push(name);
				return this;
			}
		}
	};
}
test('changing rooms cannot reset the IP rate limit', async () => {
	const app = new Namespace();
	for (const _room of ['1111111111111111', '2222222222222222']) {
		await requestRate(app.env, 'local', 'session');
	}
	expect(app.names[0]).toBe(app.names[1]);
	expect(app.names[0]).toMatch(/^rate:/);
});
test('new options invalidate the old challenge on its original shard', async () => {
	const app = new Namespace();
	await clearPreviousChallenge(app.env, 'v2.ab.' + secret);
	expect(app.names).toEqual(['auth:ab']);
	expect(app.consumeCeremony).toHaveBeenCalledOnce();
});
test('login lookup preserves the shard but stores only the secret hash', async () => {
	const store: AuthStore = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
	const auth = new PasskeyAuth(store, {}, undefined, passkeys);
	const key = await auth.loginKey(request('/', cookie));
	expect(key).toMatch(/^auth:login:v2\.cd\.[a-f0-9]{64}$/);
	expect(key).not.toContain(secret);
	expect(loginRoute(key)).toBe('auth:cd');
});

const account = { id: 'v2.ab.user', name: 'Guest' };
const assertion = {
	id: 'credential',
	rawId: 'credential',
	type: 'public-key' as const,
	response: {
		userHandle: btoa(account.id),
		clientDataJSON: '',
		authenticatorData: '',
		signature: ''
	},
	clientExtensionResults: {}
};

const localNetwork = () => ({ take: vi.fn(), register: vi.fn() });

const ceremony = {
	kind: 'login' as const,
	challenge: 'challenge',
	expiresAt: Date.now() + 1000
};
test('remote authentication routes verification, issuance and revocation to account shards', async () => {
	const app = new Namespace();
	const remote = network(app.env, 'auth:ab', localNetwork());
	expect(remote.shard).toBe('ab');
	await remote.login(assertion, 'https://photos.example', ceremony);
	await remote.issue(account);
	await remote.revoke('auth:login:v2.ab.hash');
	expect(app.names).toEqual(['auth:ab', 'auth:ab', 'auth:ab']);
	assertRemoteVerification(app);
});
test('legacy routing and empty session operations do not contact an auth shard', async () => {
	const app = new Namespace();
	const remote = network(app.env, 'mvp', { take: vi.fn(), register: vi.fn() });
	expect(remote.shard).toBeUndefined();
	await remote.revoke('');
	expect(await identity(app.env, '')).toBeUndefined();
	await expect(allowSend(app.env, '')).rejects.toThrow('ログイン');
	expect(app.names).toEqual([]);
});
test('authenticated identity and send checks reach the session issuer', async () => {
	const app = new Namespace();
	const key = 'auth:login:v2.cd.hash';
	expect(await identity(app.env, key)).toEqual({ id: 'user', name: 'Guest' });
	await allowSend(app.env, key);
	expect(app.names).toEqual(['auth:cd', 'auth:cd']);
	expect(app.authorizeSend).toHaveBeenCalledWith(key);
});
test('missing cookies choose random auth shards and missing room tokens stay empty', () => {
	expect(authRoute(request('/api/auth/login/options', cookie))).toMatch(/^auth:[a-f0-9]{2}$/);
	expect(authRoute(request('/api/auth/status'))).toMatch(/^auth:[a-f0-9]{2}$/);
	expect(roomRoute(request('/api/ws'))).toBe('');
	expect(roomRoute(request('/api/ice'))).toBe('');
	expect(roomRoute(request('/api/ice', { Authorization: 'invalid' }))).toBe('');
	expect(routedToken(undefined)).toMatch(/^[a-f0-9]{64}$/);
});

function assertRemoteVerification(app: Namespace) {
	expect(app.verifyAccountLogin).toHaveBeenCalledWith(assertion, 'https://photos.example', ceremony);
}

async function rateForIP(app: Namespace, ip: string) {
	await requestRate(app.env, ip, 'session');
}

test('IP rate limiting uses the connecting IP and account routes accept empty handles', async () => {
	const app = new Namespace();
	await rateForIP(app, '192.0.2.1');
	await rateForIP(app, '192.0.2.2');
	expect(app.names[0]).not.toBe(app.names[1]);
	const anonymous = { response: {} };
	expect(accountRoute(anonymous)).toBe('mvp');
});
