import { createPhotoAccess } from '../application/photo-access.ts';
import { afterEach, test, expect, vi } from 'vitest';
import { RoomObject } from './room-object.ts';
import { Database } from './d1.fixture.ts';
import { loginKey } from '../domain/tokens.ts';
import type { ClientMessage, ServerMessage, Session } from '../../../shared/protocol.ts';

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
	sockets: Socket[] = [];
	getWebSockets = vi.fn(() => this.sockets);
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

	socket() {
		const socket = new Socket();
		this.sockets.push(socket);
		return socket;
	}
}

class Socket {
	data: any = { connectedAt: Date.now() };
	token = '';
	readyState = 1;
	messages: ServerMessage[] = [];
	close = vi.fn((_code?: number, _reason?: string) => {
		this.readyState = 3;
	});

	serializeAttachment(data: unknown) {
		this.data = structuredClone(data);
	}

	deserializeAttachment() {
		return structuredClone(this.data);
	}

	send(raw: string) {
		this.messages.push(JSON.parse(raw));
	}

	last<T extends ServerMessage['type']>(type: T) {
		const messages = [...this.messages].reverse();
		return messages.find((message): message is Extract<ServerMessage, { type: T }> => message.type === type)!;
	}
}

const databases: Database[] = [];
const authToken = 'a'.repeat(64);
const credential = { id: 'passkey', publicKey: new Uint8Array([0, 128, 255]), counter: 0 };

afterEach(() => {
	for (const db of databases.splice(0)) {
		db.sql.close();
	}
});

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

test('websocket authentication remains single use after object recreation', async () => {
	const app = new Fixture();
	const socket = await connect(app, app.hub());
	expect(socket.last('ready').device.name).toMatch(/^ゲスト /);
	const replay = app.socket();
	await message(app.hub(), replay, { type: 'auth', token: socket.token });
	expect(replay.close).toHaveBeenCalledWith(1008, 'Invalid session');
});

test('D1 identity and send authorization connect to ICE issuance after acceptance', async () => {
	const { room, sender, receiver, id } = await sharingRoom();
	expect(sender.last('ready').device.name).toBe('Sender');
	expect((await ice(room, sender.token)).status).toBe(403);
	await message(room, receiver, { type: 'accept', id });
	expect(sender.last('start')).toEqual({ type: 'start', id });
	const response = await ice(room, sender.token);
	expect(await response.json()).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], relay: false });
});

test.each(['webSocketClose', 'webSocketError'] as const)('%s ends the transfer and notifies the receiver', async (event) => {
	const { app, room, sender, receiver, id } = await sharingRoom();
	await room[event](sender as never);
	expect(app.entries.has('transfer:' + id)).toBe(false);
	expect(receiver.last('ended')).toEqual({ type: 'ended', id, reason: 'disconnected' });
	expect(sender.readyState).toBe(3);
});

test('websocket upgrades reject the two hundred and first connection', async () => {
	const app = new Fixture();
	app.sockets = Array.from({ length: 200 }, () => new Socket());
	const request = new Request('http://localhost/api/ws', { headers: { Upgrade: 'websocket' } });
	const response = await app.hub().fetch(request);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: '混み合っています。後でお試しください。' });
});

function database() {
	const db = new Database();
	databases.push(db);
	return db;
}

async function login(db: Database) {
	await db.store.register({ id: 'sender', name: 'Sender' }, credential);
	await db.store.saveLogin(await loginKey(authToken), { account: 'sender', expiresAt: Date.now() + 60_000 });
	return 'pico_auth=' + authToken;
}

async function session(room: RoomObject, cookie: string) {
	const path = 'http://localhost/api/session?room=1234567890abcdef';
	const response = await room.fetch(new Request(path, { method: 'POST', headers: { Cookie: cookie } }));
	return (await response.json()) as Session;
}

async function connect(app: Fixture, room: RoomObject, cookie = '') {
	const identity = await session(room, cookie);
	const socket = app.socket();
	socket.token = identity.token;
	await message(room, socket, { type: 'auth', token: identity.token });
	return socket;
}

async function sharingRoom() {
	const app = new Fixture();
	const db = database();
	const room = app.hub(db.env());
	const sender = await connect(app, room, await login(db));
	const receiver = await connect(app, room);
	await message(room, sender, { type: 'create-link', files: [heic] });
	await message(room, receiver, { type: 'join-link', token: sender.last('link-created').token });
	return { app, room, sender, receiver, id: receiver.last('requested').id };
}

function message(room: RoomObject, socket: Socket, data: ClientMessage) {
	return room.webSocketMessage(socket as never, JSON.stringify(data));
}

function ice(room: RoomObject, token: string) {
	return room.fetch(new Request('http://localhost/api/ice', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }));
}
