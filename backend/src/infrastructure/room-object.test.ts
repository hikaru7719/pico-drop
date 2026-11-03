import { createPhotoAccess } from '../application/photo-access.ts';
import { test, expect, vi } from 'vitest';
import { RoomObject } from './room-object.ts';
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
		return new RoomObject(ctx as never, env as never);
	}
}
test('room fetch creates a durable anonymous session', async () => {
	const app = new Fixture();
	const response = await post(app, '/api/session?room=1234567890abcdef');
	expect(response.status).toBe(201);
	expect(app.entries.get('routing:room')).toBe('1234567890abcdef');
});
test('photo permissions remain usable through the RPC boundary', async () => {
	const app = new Fixture();
	const access = await createPhotoAccess(app.storage, [heic]);
	expect((await app.hub().consumePhoto(access.token, 'p', 'preview'))?.photo.id).toBe('p');
	await app.hub().revokePhoto(access.token);
	expect(await app.hub().consumePhoto(access.token, 'p', 'jpeg')).toBeNull();
});
const heic = { id: 'p', name: 'p.heic', type: 'image/heic', size: 16 };

function post(app: Fixture, path: string) {
	return app.hub().fetch(new Request('http://localhost' + path, { method: 'POST' }));
}

test('room alarms remove expired session state', async () => {
	const app = new Fixture();
	app.entries.set('session:expired', { expiresAt: 0 });
	await app.hub().alarm();
	expect(app.entries.has('session:expired')).toBe(false);
});
