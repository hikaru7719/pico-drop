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
	hub() {
		const ctx = {
			storage: this.storage,
			getWebSockets: this.getWebSockets,
			blockConcurrencyWhile: (fn: () => unknown) => fn()
		};
		return new NearbyHub(ctx as never, {} as never);
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
