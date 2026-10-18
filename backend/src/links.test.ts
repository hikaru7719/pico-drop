import { test, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { routedToken } from './routing.ts';
import { PasskeyAuth } from './auth.ts';
import * as protocol from '../../shared/protocol.ts';

const source = (await readFile(new URL('./index.ts', import.meta.url), 'utf8'))
	.replace(/\bimport\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?/g, '')
	.replace(/export default[\s\S]*?satisfies ExportedHandler<Bindings>;/, '');
const factory = stripTypeScriptTypes(
	`
export function createHub(deps) {
const { DurableObject, LIMITS, parseClient, authorizeTransfer, WebSocket, PasskeyAuth, routedToken } = deps;
${source.replace('export class NearbyHub', 'class NearbyHub')}
return NearbyHub;
}`,
	{ mode: 'transform' }
);
const { createHub } = await import(
	`data:text/javascript;base64,${Buffer.from(factory).toString('base64')}`
);
const files = [{ id: 'p', name: 'photo.jpg', type: 'image/jpeg', size: 8 }];
class Socket {
	data: any;
	messages: any[] = [];
	readyState = 1;
	constructor(id: string) {
		this.data = {
			connectedAt: Date.now(),
			authKey: id === 'sender' ? 'auth:login:test' : undefined,
			session: testSession(id)
		};
	}
	deserializeAttachment() {
		return structuredClone(this.data);
	}
	serializeAttachment(data: any) {
		this.data = structuredClone(data);
	}
	send(raw: string) {
		this.messages.push(JSON.parse(raw));
	}
	close() {
		this.readyState = 3;
	}
	last(type: string) {
		return [...this.messages].reverse().find((m) => m.type === type);
	}
}
class Fixture {
	entries = new Map<string, any>();
	sockets = ['sender', 'receiver', 'outsider'].map((id) => new Socket(id));
	hub: any;
	queue = Promise.resolve();
	constructor() {
		const Hub = createHub({
			...protocol,
			PasskeyAuth,
			routedToken,
			WebSocket: { OPEN: 1 },
			DurableObject: this.base()
		});
		this.hub = new Hub(this.context());
	}

	seedIdentity() {
		this.entries.set('auth:login:test', {
			account: 'sender',
			expiresAt: Date.now() + 60_000
		});
		this.entries.set('auth:account:sender', { id: 'sender', name: 'Sender' });
	}
	context() {
		this.seedIdentity();
		return {
			storage: this.storage(),
			getWebSockets: () => this.sockets,
			blockConcurrencyWhile: (fn: () => unknown) => this.serialize(fn)
		};
	}
	serialize(fn: () => unknown) {
		const task = this.queue.then(fn);
		this.queue = task.then(
			() => {},
			() => {}
		);
		return task;
	}

	base() {
		return class {
			constructor(public ctx: unknown) {}
		};
	}
	storage() {
		return {
			get: async (key: string) => this.entries.get(key),
			put: async (key: string, value: any) =>
				this.entries.set(key, structuredClone(value)),
			delete: async (key: string) => this.entries.delete(key),
			getAlarm: async () => 1,
			list: async () => new Map(this.entries)
		};
	}
	async message(index: number, message: unknown) {
		await this.hub.webSocketMessage(
			this.sockets[index],
			JSON.stringify(message)
		);
	}
	async link() {
		await this.message(0, { type: 'create-link', files });
		return this.sockets[0].last('link-created');
	}
}
test('link is hashed, bounded to ten minutes, consumed once, and approval gates RTC', async () => {
	const app = new Fixture();
	const link = await app.link();
	expect(link.token).toMatch(/^[a-f0-9]{64}$/);
	expect(link.expiresAt - Date.now()).toBeLessThanOrEqual(
		protocol.LIMITS.linkMs
	);
	expect([...app.entries.keys()][0]).not.toContain(link.token);
	await checkJoin(app, link.token);
});
async function checkJoin(app: Fixture, token: string) {
	await app.message(1, { type: 'join-link', token });
	const t = app.sockets[1].last('requested');
	expect(t).toEqual(app.sockets[0].last('requested'));
	await app.message(2, { type: 'join-link', token });
	expect(app.sockets[2].last('error').message).toMatch(/すでに使われた/);
	await checkApproval(app, t.id);
}
async function checkApproval(app: Fixture, id: string) {
	await app.message(0, { type: 'accept', id });
	expect(app.sockets[0].last('error').message).toMatch(/受信者/);
	await app.message(1, { type: 'accept', id });
	expect(app.sockets[0].last('start').id).toBe(id);
	expect(app.sockets[1].last('start').id).toBe(id);
}
test('expired links reject entry even before the cleanup alarm', async () => {
	vi.useFakeTimers();
	try {
		await checkExpiry();
	} finally {
		vi.useRealTimers();
	}
});
async function checkExpiry() {
	const app = new Fixture();
	const link = await app.link();
	vi.setSystemTime(link.expiresAt);
	await app.message(1, { type: 'join-link', token: link.token });
	expect(app.sockets[1].last('error').message).toMatch(/有効期限が切れた/);
	expect(app.sockets[1].last('requested')).toBeUndefined();
}
for (const reason of ['revoke', 'disconnect', 'replace']) {
	test(`${reason} invalidates the previous invitation`, async () => {
		const app = new Fixture();
		const link = await app.link();
		await invalidate(app, reason);
		await app.message(1, { type: 'join-link', token: link.token });
		expect(app.sockets[1].last('error').message).toMatch(/有効期限が切れた/);
	});
}
async function invalidate(app: Fixture, reason: string) {
	if (reason === 'disconnect') {
		await app.hub.webSocketClose(app.sockets[0]);
	} else {
		await app.message(0, invalidationMessage(reason));
	}
}
test('self joining and legacy discovery cannot create a transfer', async () => {
	const app = new Fixture();
	const link = await app.link();
	await app.message(0, { type: 'join-link', token: link.token });
	await app.message(1, { type: 'request', to: 'sender', files });
	expect(app.sockets[0].last('requested')).toBeUndefined();
	expect(app.sockets[1].last('error').message).toMatch(/不正/);
});

function invalidationMessage(reason: string) {
	return reason === 'replace'
		? { type: 'create-link', files }
		: { type: 'revoke-link' };
}

test('simultaneous participants consume an invitation only once', async () => {
	const app = new Fixture();
	const link = await app.link();
	await Promise.all(
		[1, 2].map((i) => app.message(i, { type: 'join-link', token: link.token }))
	);
	assertSingleParticipant(app);
});
function assertSingleParticipant(app: Fixture) {
	const requests = app.sockets[0].messages.filter(
		(m) => m.type === 'requested'
	);
	expect(requests).toHaveLength(1);
	expect(app.sockets.filter((ws) => ws.last('error'))).toHaveLength(1);
}
test('the alarm notifies the sender and releases expired invitations', async () => {
	const app = new Fixture();
	const link = await app.link();
	const key = app.sockets[0].data.linkKey;
	await app.hub.expireEntry(key, link.expiresAt, link.expiresAt);
	expect(app.entries.has(key)).toBe(false);
	expect(app.sockets[0].last('link-ended')).toBeDefined();
});
test('joining near expiry preserves the separate approval and transfer deadlines', async () => {
	vi.useFakeTimers();
	try {
		await checkSeparateDeadlines();
	} finally {
		vi.useRealTimers();
	}
});
async function checkSeparateDeadlines() {
	const app = new Fixture();
	const link = await app.link();
	vi.setSystemTime(link.expiresAt - 1);
	await app.message(1, { type: 'join-link', token: link.token });
	vi.setSystemTime(link.expiresAt + 1);
	await checkApproval(app, app.sockets[1].last('requested').id);
	await checkTransferDeadline(app);
}
async function checkTransferDeadline(app: Fixture) {
	const id = app.sockets[1].last('requested').id;
	const transfer = app.entries.get('transfer:' + id);
	expect(transfer.expiresAt).toBe(Date.now() + protocol.LIMITS.transferMs);
	await app.hub.expireEntries(Date.now());
	expect(app.entries.has('transfer:' + id)).toBe(true);
}

test('anonymous receivers cannot create a link', async () => {
	const app = new Fixture();
	await app.message(1, { type: 'create-link', files });
	expect(app.sockets[1].last('error').message).toContain('ログイン');
	expect(app.sockets[1].last('link-created')).toBeUndefined();
});

test('revoking the login blocks an already authenticated signaling socket', async () => {
	const app = new Fixture();
	app.entries.delete('auth:login:test');
	await app.message(0, { type: 'create-link', files });
	expect(app.sockets[0].last('error').message).toContain('ログイン');
});

test('disabled accounts cannot send', async () => {
	const app = new Fixture();
	app.entries.get('auth:account:sender').disabled = true;
	await app.message(0, { type: 'create-link', files });
	expect(app.sockets[0].last('error').message).toContain('ログイン');
});

function testSession(id: string) {
	return { id, name: id, expiresAt: Date.now() + protocol.LIMITS.sessionMs };
}

test('persistent accounts survive cleanup without keeping an idle alarm active', async () => {
	const app = new Fixture();
	app.sockets = [];
	await app.hub.expireEntries(Date.now() + 60_001);
	expect(app.entries.has('auth:account:sender')).toBe(true);
	expect(await app.hub.nextAlarm(Date.now())).toBe(Infinity);
});
