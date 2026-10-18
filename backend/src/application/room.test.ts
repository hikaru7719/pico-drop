import { test, expect, vi } from 'vitest';
import { RoomService } from './room.ts';
import { AuthService } from './auth.ts';
import { passkeys } from '../infrastructure/passkeys.ts';
import * as protocol from '../../../shared/protocol.ts';
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
	deadline: number | null = null;
	constructor() {
		this.hub = new RoomService(
			this.context() as never,
			this.environment() as never
		);
	}
	environment() {
		const auth = new AuthService(this.storage() as never, undefined, passkeys);
		return {
			identity: (key: string) => auth.identity(key),
			allowSend: (key: string) => auth.allowSend(key),
			iceServers: async () => ({ iceServers: [], relay: false })
		};
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
			getRoomSockets: () => this.sockets,
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

	storage() {
		return {
			get: async (key: string) => this.entries.get(key),
			put: this.put,
			delete: async (key: string) => this.entries.delete(key),
			getAlarm: async () => this.deadline,
			setAlarm: this.setAlarm,
			list: async () => new Map(this.entries)
		};
	}
	put = async (key: string, value: any) =>
		this.entries.set(key, structuredClone(value));
	setAlarm = async (time: number) => {
		this.deadline = time;
	};
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

async function groupLink(app: Fixture) {
	await app.message(0, { type: 'create-link', files, mode: 'group' });
	return app.sockets[0].last('link-created');
}
async function joinGroup(app: Fixture, token: string, index: number) {
	await app.message(index, { type: 'join-link', token });
	return app.sockets[index].last('requested').id as string;
}
async function approveGroup(app: Fixture, id: string, index: number) {
	await app.message(0, { type: 'approve', id });
	await app.message(index, { type: 'accept', id });
}
function members(app: Fixture) {
	return app.sockets[0].last('group-state').participants;
}
test('group requires sender confirmation and receiver consent before signaling', async () => {
	const app = new Fixture();
	const link = await groupLink(app);
	const id = await joinGroup(app, link.token, 1);
	await app.message(1, { type: 'accept', id });
	expect(app.sockets[0].last('start')).toBeUndefined();
	await assertGroupPermissions(app, id);
	await app.message(0, { type: 'approve', id });
	expect(app.sockets[0].last('start').id).toBe(id);
});
async function assertGroupPermissions(app: Fixture, id: string) {
	await app.message(2, { type: 'approve', id });
	await app.message(1, { type: 'approve', id });
	expect(app.sockets[1].last('error').message).toMatch(/送信者/);
	await app.message(1, testSignal(id));
	expect(app.sockets[0].last('signal')).toBeUndefined();
	expect(app.sockets[2].last('group-state')).toBeUndefined();
}
test('same QR admits several recipients and transfers sequentially after completion', async () => {
	const app = new Fixture();
	const link = await groupLink(app);
	const first = await joinGroup(app, link.token, 1);
	const second = await joinGroup(app, link.token, 2);
	await approveGroup(app, first, 1);
	await approveGroup(app, second, 2);
	await assertSequentialCompletion(app, first, second);
});
async function assertSequentialCompletion(
	app: Fixture,
	first: string,
	second: string
) {
	assertQueued(app);
	await app.message(1, { type: 'complete', id: first });
	assertNextStarted(app, second);
}
test('group admission is bounded even when six people join concurrently', async () => {
	const app = new Fixture();
	app.sockets.push(...[3, 4, 5, 6].map((i) => new Socket('guest-' + i)));
	const link = await groupLink(app);
	await joinMany(app, link.token);
	expect(members(app)).toHaveLength(5);
	expect(app.sockets.filter((ws) => ws.last('requested'))).toHaveLength(5);
	expect(app.sockets.filter((ws) => ws.last('error'))).toHaveLength(1);
});
for (const kind of ['revoke', 'disconnect', 'expire']) {
	test(`group ${kind} stops current and queued transfers and closes admission`, async () => {
		const app = new Fixture();
		const link = await groupLink(app);
		const first = await joinGroup(app, link.token, 1);
		const second = await joinGroup(app, link.token, 2);
		await approveGroup(app, first, 1);
		await approveGroup(app, second, 2);
		await stopAndCheckGroup(app, link, kind);
	});
}
async function stopAndCheckGroup(app: Fixture, link: any, kind: string) {
	await stopDistribution(app, link, kind);
	expect(app.sockets[2].last('start')).toBeUndefined();
	expect(
		[...app.entries.keys()].filter((key) => key.startsWith('transfer:'))
	).toHaveLength(0);
	await app.message(2, { type: 'join-link', token: link.token });
	expect(app.sockets[2].last('error').message).toMatch(/有効期限/);
}
for (const action of ['reject', 'fail', 'disconnect']) {
	test(`individual ${action} does not stop the next recipient`, async () => {
		const app = new Fixture();
		const link = await groupLink(app);
		const first = await joinGroup(app, link.token, 1);
		const second = await joinGroup(app, link.token, 2);
		await approveGroup(app, second, 2);
		await endMember(app, first, action);
		expect(app.sockets[2].last('start').id).toBe(second);
	});
}
async function endMember(app: Fixture, id: string, action: string) {
	if (action === 'disconnect') {
		await app.hub.webSocketClose(app.sockets[1]);
	} else {
		await app.message(1, { type: action, id });
	}
}
test('failed recipient can retry twice in the same slot with fresh confirmation', async () => {
	const app = new Fixture();
	const link = await groupLink(app);
	for (let attempt = 1; attempt <= 3; attempt++) {
		await failedAttempt(app, link.token, attempt);
	}
	await app.message(1, { type: 'join-link', token: link.token });
	expect(app.sockets[1].last('error').message).toMatch(/2回まで/);
	expect(members(app)).toHaveLength(1);
});
async function failedAttempt(app: Fixture, token: string, attempt: number) {
	const id = await joinGroup(app, token, 1);
	expectFreshConfirmation(app, attempt);
	await approveGroup(app, id, 1);
	await app.message(1, { type: 'fail', id });
	expect(members(app)[0].status).toBe('failed');
}
test('anonymous sessions cannot create group distributions', async () => {
	const app = new Fixture();
	await app.message(1, { type: 'create-link', files, mode: 'group' });
	expect(app.sockets[1].last('error').message).toContain('ログイン');
});

function testSignal(id: string) {
	return {
		type: 'signal',
		id,
		signal: { description: { type: 'offer', sdp: '' } }
	};
}
function memberStatuses(app: Fixture) {
	return members(app).map((p: protocol.GroupParticipant) => p.status);
}
async function joinMany(app: Fixture, token: string) {
	await Promise.all(
		[1, 2, 3, 4, 5, 6].map((i) => app.message(i, { type: 'join-link', token }))
	);
}
async function stopDistribution(app: Fixture, link: any, kind: string) {
	if (kind === 'expire') {
		await expireDistribution(app, link.expiresAt);
	} else {
		await invalidate(app, kind);
	}
}
function expectFreshConfirmation(app: Fixture, attempts: number) {
	expect(members(app)[0]).toMatchObject({
		attempts,
		approved: false,
		accepted: false
	});
}

test('failure during transfer advances the already approved queue', async () => {
	const app = new Fixture();
	const link = await groupLink(app);
	const first = await joinGroup(app, link.token, 1);
	const second = await joinGroup(app, link.token, 2);
	await approveGroup(app, first, 1);
	await approveGroup(app, second, 2);
	await app.message(1, { type: 'fail', id: first });
	expect(app.sockets[2].last('start').id).toBe(second);
});

function assertQueued(app: Fixture) {
	expect(app.sockets[2].last('start')).toBeUndefined();
	expect(memberStatuses(app)).toEqual(['transferring', 'queued']);
}
async function expireDistribution(app: Fixture, expiresAt: number) {
	await app.hub.expireEntry(app.sockets[0].data.linkKey, expiresAt, expiresAt);
}

function assertNextStarted(app: Fixture, second: string) {
	expect(app.sockets[1].last('ended').photoAccess).toBeDefined();
	expect(app.sockets[2].last('start').id).toBe(second);
	expect(memberStatuses(app)).toEqual(['complete', 'transferring']);
}

test('group transfers never extend the distribution deadline', async () => {
	const app = new Fixture();
	const link = await groupLink(app);
	const id = await joinGroup(app, link.token, 1);
	await approveGroup(app, id, 1);
	expect(app.entries.get('transfer:' + id).expiresAt).toBe(link.expiresAt);
});

async function newConnection(app: Fixture, authKey = '') {
	const session = await app.hub.createSession({
		room: '1234567890abcdef',
		authKey
	});
	const ws = new Socket('new');
	delete ws.data.session;
	app.sockets.push(ws);
	return { session, ws, index: app.sockets.length - 1 };
}
test('sessions store only a token hash and authenticate once after reconnect', async () => {
	const app = new Fixture();
	const { session, ws, index } = await newConnection(app, 'auth:login:test');
	expect(session.name).toBe('Sender');
	expect([...app.entries.keys()].join()).not.toContain(session.token);
	await app.message(index, { type: 'auth', token: session.token });
	expect(ws.last('ready').device.id).toBe(session.id);
	await rejectSessionReplay(app, session.token);
});
async function rejectSessionReplay(app: Fixture, token: string) {
	const { ws, index } = await newConnection(app);
	await app.message(index, { type: 'auth', token });
	expect(ws.readyState).toBe(3);
}
test('legacy anonymous sessions are supported without room metadata', async () => {
	const app = new Fixture();
	const session = await app.hub.createSession({ authKey: '' });
	expect(session.name).toMatch(/^ゲスト /);
	expect(session.room).toBeUndefined();
	expect(app.entries.get('routing:room')).toBe('');
});
test.each(['missing', 'expired', 'used'])(
	'rejects a %s session before accepting a socket',
	async (kind) => {
		const app = new Fixture();
		const { session, ws, index } = await newConnection(app);
		alterSession(app, session, kind);
		await app.message(index, { type: 'auth', token: session.token });
		expect(ws.readyState).toBe(3);
		expect(ws.last('ready')).toBeUndefined();
	}
);
function alterSession(app: Fixture, session: protocol.Session, kind: string) {
	const entry = [...app.entries].find(([, value]) => value.id === session.id)!;
	if (kind === 'missing') {
		app.entries.delete(entry[0]);
	} else if (kind === 'expired') {
		entry[1].expiresAt = 0;
	} else {
		entry[1].used = true;
	}
}
test('ICE rejects invalid tokens and disconnected sessions', async () => {
	const app = new Fixture();
	const { session } = await newConnection(app);
	for (const token of ['', 'x', 'a'.repeat(64), session.token]) {
		await iceError(app, token, 'unauthorized');
	}
	alterSession(app, session, 'expired');
	await iceError(app, session.token, 'unauthorized');
});
async function connectedSession(app: Fixture) {
	const connection = await newConnection(app);
	await app.message(connection.index, {
		type: 'auth',
		token: connection.session.token
	});
	return connection;
}
test('ICE requires an active transfer and consumes a bounded quota', async () => {
	const app = new Fixture();
	const { session, ws } = await connectedSession(app);
	await iceError(app, session.token, 'forbidden');
	seedIceTransfer(app, ws);
	await exhaustIce(app, session.token);
	await iceError(app, session.token, 'rate-limit');
});
function seedIceTransfer(app: Fixture, ws: Socket) {
	ws.data.transfer = 'ice-transfer';
	app.entries.set('transfer:ice-transfer', {
		started: true,
		expiresAt: Date.now() + 10000
	});
}
test.each(['missing', 'pending', 'expired'])(
	'ICE rejects a %s transfer',
	async (kind) => {
		const app = new Fixture();
		const { session, ws } = await connectedSession(app);
		seedIceTransfer(app, ws);
		alterIceTransfer(app, kind);
		await expect(app.hub.ice(session.token)).rejects.toMatchObject({
			code: 'forbidden'
		});
	}
);
function alterIceTransfer(app: Fixture, kind: string) {
	const transfer = app.entries.get('transfer:ice-transfer');
	if (kind === 'missing') {
		app.entries.delete('transfer:ice-transfer');
	} else if (kind === 'pending') {
		transfer.started = false;
	} else {
		transfer.expiresAt = 0;
	}
}
test('group senders have a bounded larger ICE allowance', async () => {
	const app = new Fixture();
	const { session, ws } = await connectedSession(app);
	seedIceTransfer(app, ws);
	ws.data.linkKey = 'link:group';
	ws.data.turnCount =
		protocol.LIMITS.participants * protocol.LIMITS.groupAttempts - 1;
	expect((await app.hub.ice(session.token)).relay).toBe(false);
	await iceError(app, session.token, 'rate-limit');
});
test('TURN failures become an application error', async () => {
	const app = new Fixture();
	const deps = failingTurn(app);
	const service = new RoomService(app.context() as never, deps);
	await expect(service.iceServers()).rejects.toMatchObject({
		code: 'unavailable'
	});
});
test('control messages reject binary, oversized and invalid JSON payloads', async () => {
	const app = new Fixture();
	for (const raw of [new ArrayBuffer(1), 'x'.repeat(24001), '{']) {
		await app.hub.webSocketMessage(app.sockets[0], raw);
		expect(app.sockets[0].last('error')).toBeDefined();
	}
});
test('message quota closes abusive sockets and a new window resets counters', async () => {
	const app = new Fixture();
	app.sockets[0].data.window = Date.now() - 60001;
	app.sockets[0].data.messages = 240;
	await app.message(0, { type: 'revoke-link' });
	expect(app.sockets[0].readyState).toBe(1);
	app.sockets[0].data.messages = 240;
	await app.message(0, { type: 'revoke-link' });
	expect(app.sockets[0].readyState).toBe(3);
});
test('unauthenticated and expired sockets cannot send controls', async () => {
	const app = new Fixture();
	delete app.sockets[0].data.session;
	app.sockets[1].data.session.expiresAt = 0;
	for (const index of [0, 1]) {
		await app.message(index, { type: 'revoke-link' });
	}
	expect(app.sockets.slice(0, 2).map((ws) => ws.readyState)).toEqual([3, 3]);
});
test('socket errors close connections and complete cleanup', async () => {
	const app = new Fixture();
	await app.link();
	await app.hub.webSocketError(app.sockets[0]);
	expect(app.sockets[0].readyState).toBe(3);
	expect([...app.entries.keys()].some((key) => key.startsWith('link:'))).toBe(
		false
	);
});
test('alarms close idle unauthenticated and expired authenticated sockets', async () => {
	const app = new Fixture();
	delete app.sockets[0].data.session;
	app.sockets[0].data.connectedAt = Date.now() - 10001;
	app.sockets[1].data.session.expiresAt = 0;
	await app.hub.alarm();
	expect(app.sockets.map((ws) => ws.readyState)).toEqual([3, 3, 1]);
	expect(app.deadline).toBeGreaterThan(Date.now());
});
test('expiry schedules the first expiring record when no sockets remain', async () => {
	const app = new Fixture();
	app.sockets = [];
	app.entries.set('session:later', { expiresAt: Date.now() + 60000 });
	await app.hub.alarm();
	expect(app.deadline).toBe(app.entries.get('session:later').expiresAt);
});
test('a socket closing during an outgoing message does not break cleanup', async () => {
	const app = new Fixture();
	vi.spyOn(app.sockets[0], 'send').mockImplementation(() => {
		throw new Error('closed');
	});
	await app.link();
	expect([...app.entries.keys()].some((key) => key.startsWith('link:'))).toBe(
		true
	);
});

async function iceError(app: Fixture, token: string, code: string) {
	await expect(app.hub.ice(token)).rejects.toMatchObject({ code });
}
async function exhaustIce(app: Fixture, token: string) {
	for (let i = 0; i < 10; i++) {
		expect(await app.hub.ice(token)).toEqual({ iceServers: [], relay: false });
	}
}
function failingTurn(app: Fixture) {
	return {
		...app.environment(),
		iceServers: vi.fn().mockRejectedValue(new Error('secret'))
	};
}
