import { sessionLoginKey } from '../domain/tokens.ts';
import { createPhotoAccess } from '../application/photo-access.ts';
import { test, expect, vi } from 'vitest';
import { NearbyHub } from './nearby-hub.ts';
vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown
		) {}
	}
}));
class Fixture {
	entries = new Map<string, any>();
	deadline: number | null = null;
	getWebSockets = vi.fn(() => []);
	storage = {
		get: async (key: string) => this.entries.get(key),
		put: async (key: string, value: unknown) => {
			this.entries.set(key, structuredClone(value));
		},
		delete: async (key: string) => this.entries.delete(key),
		list: async () => new Map(this.entries),
		getAlarm: async () => this.deadline,
		setAlarm: async (value: number) => {
			this.deadline = value;
		}
	};
	hub(env = {}) {
		const ctx = {
			storage: this.storage,
			getWebSockets: this.getWebSockets,
			blockConcurrencyWhile: (fn: () => unknown) => fn()
		};
		return new NearbyHub(ctx as never, env as never);
	}
}
test('existing auth keys remain readable after replacing the adapter instance', async () => {
	const app = new Fixture();
	seedLogin(app);
	expect(await app.hub().accountIdentity('auth:login:old')).toEqual(account);
	expect(app.entries.get('hub:role')).toBe('auth');
	await app.hub().revokeLogin('auth:login:old');
	expect(await app.hub().accountIdentity('auth:login:old')).toBeUndefined();
});
test('auth alarms retain accounts and never inspect room sockets', async () => {
	const app = new Fixture();
	app.entries.set('hub:role', 'auth');
	app.entries.set('auth:account:user', { id: 'user', name: 'Sender' });
	app.entries.set('auth:challenge:old', { expiresAt: 0 });
	await app.hub().alarm();
	expect(app.entries.has('auth:account:user')).toBe(true);
	expect(app.entries.has('auth:challenge:old')).toBe(false);
	expect(app.getWebSockets).not.toHaveBeenCalled();
});
test('IP limits persist across adapter instances and expire independently of rooms', async () => {
	const app = new Fixture();
	await exhaustQuota(app);
	expect(await app.hub().limitRequest('session')).toBe(false);
	app.entries.get('rate:session').expiresAt = 0;
	await app.hub().alarm();
	expect(await app.hub().limitRequest('session')).toBe(true);
	expect(app.getWebSockets).not.toHaveBeenCalled();
});
test('objects predating role metadata can still clean up expired records', async () => {
	const app = new Fixture();
	app.entries.set('session:expired', { expiresAt: 0 });
	app.entries.set('auth:account:legacy', { id: 'legacy', name: 'Legacy' });
	await app.hub().alarm();
	expect(app.entries.has('session:expired')).toBe(false);
	expect(app.entries.has('auth:account:legacy')).toBe(true);
});

const account = { id: 'user', name: 'Sender' };
function seedLogin(app: Fixture) {
	app.entries.set('auth:account:user', account);
	app.entries.set('auth:login:old', {
		account: 'user',
		expiresAt: Date.now() + 10000
	});
}
async function exhaustQuota(app: Fixture) {
	for (let i = 0; i < 20; i++) {
		expect(await app.hub().limitRequest('session')).toBe(true);
	}
}

test('registered accounts survive adapter recreation and issued logins can send', async () => {
	const app = new Fixture();
	await app.hub().registerAccount(account, credential);
	const token = await app.hub().issueAccountLogin(account);
	const key = await sessionLoginKey(token);
	expect(await app.hub().accountIdentity(key)).toEqual(account);
	expect(await app.hub().authorizeSend(key)).toEqual(account);
	expect(app.deadline).toBeGreaterThan(Date.now());
});
const credential = {
	id: 'credential',
	publicKey: new Uint8Array([1]),
	counter: 0
};
test('sharded logins retain routing prefixes and empty revocation is harmless', async () => {
	const app = new Fixture();
	const sharded = { ...account, id: 'v2.ab.user' };
	await app.hub().registerAccount(sharded, credential);
	expect(await app.hub({ HUB: {} }).issueAccountLogin(sharded)).toMatch(
		/^v2\.ab\./
	);
	await app.hub().revokeLogin('');
	expect(app.entries.has('auth:account:v2.ab.user')).toBe(true);
});
test('HTTP authentication schedules cleanup and consumes ceremonies exactly once', async () => {
	const app = new Fixture();
	const response = await post(app, '/api/auth/login/options');
	expect(response.status).toBe(200);
	const key = challenge(app);
	expect((await app.hub().consumeCeremony(key))?.kind).toBe('login');
	expect(await app.hub().consumeCeremony(key)).toBeUndefined();
	expect(app.deadline).toBeGreaterThan(Date.now());
});
test('room fetch creates a durable anonymous session', async () => {
	const app = new Fixture();
	const response = await post(app, '/api/session?room=1234567890abcdef');
	expect(response.status).toBe(201);
	expect(app.entries.get('hub:role')).toBe('room');
	expect(app.entries.get('routing:room')).toBe('1234567890abcdef');
});
test('photo permissions remain usable through the RPC boundary', async () => {
	const app = new Fixture();
	const access = await createPhotoAccess(app.storage, [heic]);
	expect(
		(await app.hub().consumePhoto(access.token, 'p', 'preview'))?.photo.id
	).toBe('p');
	await app.hub().revokePhoto(access.token);
	expect(await app.hub().consumePhoto(access.token, 'p', 'jpeg')).toBeNull();
});
test('auth rate quotas use the longer auth window', async () => {
	const app = new Fixture();
	for (let i = 0; i < 30; i++) {
		expect(await app.hub().limitRequest('auth')).toBe(true);
	}
	expect(await app.hub().limitRequest('auth')).toBe(false);
	expect(app.deadline! - Date.now()).toBeGreaterThan(590000);
});

const heic = { id: 'p', name: 'p.heic', type: 'image/heic', size: 16 };
function post(app: Fixture, path: string) {
	return app
		.hub()
		.fetch(new Request('http://localhost' + path, { method: 'POST' }));
}
function challenge(app: Fixture) {
	return [...app.entries.keys()].find((key) =>
		key.startsWith('auth:challenge:')
	)!;
}
