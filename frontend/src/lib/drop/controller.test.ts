import { test, vi, afterEach, expect } from 'vitest';
import assert from 'node:assert/strict';
import {
	LIMITS,
	type ServerMessage,
	type Session,
	type ClientMessage,
	type GroupParticipant
} from '../../../../shared/protocol.ts';
import { createDropController, type DropDependencies } from './controller.svelte';
import type { SignalingConnection } from '../webrtc/signaling';
import type { TransferFactory, IceConfig } from '../webrtc/connection';
import { PHOTO_LIFETIME_MS } from '../../../../shared/photos.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.unstubAllGlobals();
	vi.resetAllMocks();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type SetupOptions = { pendingSession?: boolean; token?: string };

class FakeSocket implements SignalingConnection {
	closed = false;
	messages: unknown[] = [];

	constructor(
		public emit: (message: ServerMessage) => void,
		public disconnected: () => void
	) {}

	send(message: ClientMessage) {
		this.messages.push(message);
	}

	close() {
		this.closed = true;
	}
}
class PageFixture {
	events = new Map<string, (event?: unknown) => void>();
	sockets: FakeSocket[] = [];
	sessions = 0;
	sessionSignal: AbortSignal | undefined;
	resolvePending: (value: Session) => void = () => {};
	session = {
		id: 'self',
		name: 'Self',
		token: 'token',
		expiresAt: 9999999999999
	};
	controller: ReturnType<typeof createDropController>;
	transfers: FakeTransfer[] = [];
	view = {
		clearSelection: vi.fn(),
		showTransfer: vi.fn(),
		showReceived: vi.fn()
	};
	createTransfer: TransferFactory = (...args) => {
		const transfer = new FakeTransfer(args);
		this.transfers.push(transfer);
		return transfer;
	};
	dependencies = {
		createSession: vi.fn<DropDependencies['createSession']>((signal) => this.createSession(signal)),
		createSignaling: vi.fn<DropDependencies['createSignaling']>((...args) => this.openSocket(...args)),
		createTransfer: this.createTransfer,
		describePhotos: vi.fn<DropDependencies['describePhotos']>().mockResolvedValue(files),
		sharePhotos: vi.fn<DropDependencies['sharePhotos']>(),
		fetch: vi.fn<DropDependencies['fetch']>()
	} satisfies DropDependencies;

	constructor(private options: SetupOptions) {
		vi.stubGlobal('window', this.window());
		this.controller = createDropController(this.view, this.dependencies);
		cleanups.push(this.controller.mount());
	}

	openSocket(...args: Parameters<DropDependencies['createSignaling']>) {
		const socket = new FakeSocket(args[1], args[2]);
		this.sockets.push(socket);
		return socket;
	}

	window() {
		return {
			isSecureContext: true,
			location: this.location(),
			RTCPeerConnection: class {},
			addEventListener: (name: string, callback: () => void) => this.events.set(name, callback),
			removeEventListener: (name: string) => this.events.delete(name)
		};
	}

	location() {
		return {
			origin: 'https://example.com',
			hash: this.options.token ? '#share=' + this.options.token : ''
		};
	}

	async createSession(signal: AbortSignal) {
		this.sessions++;
		this.sessionSignal = signal;
		return this.options.pendingSession
			? new Promise<Session>((resolve) => {
					this.resolvePending = resolve;
				})
			: this.session;
	}

	resolveSession() {
		this.resolvePending(this.session);
	}
}

async function emit(app: PageFixture, message: ServerMessage) {
	app.sockets[0].emit(message);
	await flush();
}

const setup = (options: SetupOptions = {}) => new PageFixture(options);

const flush = async () => {
	for (let i = 0; i < 12; i++) {
		await Promise.resolve();
	}
};

function assertIdle(app: PageFixture) {
	assert.equal(app.controller.connection, 'idle');
	assert.equal(app.sessions, 0);
	assert.equal(app.sockets.length, 0);
}

test('opening and restoring the page do not contact signaling', async () => {
	const app = setup();
	await flush();
	assertIdle(app);
	app.events.get('pagehide')!();
	app.events.get('pageshow')!({ persisted: true });
	await flush();
	assertIdle(app);
});
const files = [{ id: 'photo', name: 'photo.jpg', type: 'image/jpeg', size: 8 }];

async function connectOnce(app: PageFixture) {
	await app.controller.select([]);
	await Promise.all([app.controller.createLink(), app.controller.createLink()]);
	assert.equal(app.sessions, 1);
	assert.equal(app.controller.connection, 'connecting');
	assert.equal(app.sockets[0].messages.length, 0);
}

async function ready(app: PageFixture) {
	app.sockets[0].emit({ type: 'ready', device: app.session });
	await flush();
}

function assertStopped(app: PageFixture) {
	assert.equal(app.sockets[0].closed, true);
	assert.equal(app.controller.connection, 'idle');
}

test('authentication creates a link without requesting location; revocation closes signaling', async () => {
	const app = setup();
	await connectOnce(app);
	await ready(app);
	assert.deepEqual(app.sockets[0].messages, [{ type: 'create-link', files }]);
	await assertLinkCreated(app);
	app.controller.revokeLink();
	assertStopped(app);
	assert.equal(app.controller.shareLink, '');
});

async function assertLinkCreated(app: PageFixture) {
	await emit(app, {
		type: 'link-created',
		token: 'a'.repeat(64),
		expiresAt: Date.now() + LIMITS.linkMs
	});
	const expected = 'https://example.com/#share=' + 'a'.repeat(64);
	assert.equal(app.controller.shareLink, expected);
}

test('stopping an in-flight session request prevents a late WebSocket connection', async () => {
	const app = setup({ pendingSession: true });
	await app.controller.select([]);
	const pending = app.controller.createLink();
	app.controller.revokeLink();
	assert.equal(app.sessionSignal?.aborted, true);
	app.resolveSession();
	await pending;
	assert.equal(app.sockets.length, 0);
});
test('opening a link automatically joins but does not accept the transfer', async () => {
	const token = 'b'.repeat(64);
	const app = setup({ token });
	await flush();
	assert.equal(app.sessions, 1);
	await ready(app);
	assert.deepEqual(app.sockets[0].messages, [{ type: 'join-link', token }]);
	app.controller.revokeLink();
});
test('a rejected link clears the busy state and permits retry', async () => {
	const app = setup({ token: 'b'.repeat(64) });
	await flush();
	await ready(app);
	await emit(app, { type: 'error', message: '期限切れ' });
	assert.equal(app.controller.error, '期限切れ');
	app.controller.revokeLink();
});

async function requestTransfer(app: PageFixture) {
	await emit(app, {
		type: 'requested',
		id: 'transfer',
		from: app.session,
		to: { id: 'other', name: 'Other' },
		files
	});
}

for (const reason of ['complete', 'cancelled'] as const) {
	test(`transfer ${reason} closes signaling and clears link`, async () => {
		const app = setup();
		await connectOnce(app);
		await ready(app);
		await requestTransfer(app);
		await emit(app, { type: 'ended', id: 'transfer', reason });
		assertStopped(app);
		assert.equal(app.controller.completed, reason === 'complete');
	});
}

test('invalid invitation does not create a session', async () => {
	const app = setup({ token: 'invalid' });
	await flush();
	assertIdle(app);
	assert.match(app.controller.error, /共有リンクが正しくありません/);
});

test('photo removal keeps files and metadata aligned without affecting another controller', async () => {
	const app = setup();
	const other = createDropController();
	await app.controller.select([new File(['photo'], 'photo.jpg')]);
	app.controller.removePhoto(0);
	assert.equal(app.controller.selected.length, 0);
	assert.equal(app.controller.metadata.length, 0);
	assert.equal(other.connection, 'idle');
	assert.equal(other.metadata.length, 0);
});

test('photos cannot be removed while a link is being created', async () => {
	const app = setup({ pendingSession: true });
	await app.controller.select([new File(['photo'], 'photo.jpg')]);
	const pending = app.controller.createLink();
	app.controller.removePhoto(0);
	assert.equal(app.controller.selected.length, 1);
	assert.equal(app.controller.metadata.length, 1);
	app.resolveSession();
	await pending;
});

test('unmount removes listeners and ignores queued socket messages', async () => {
	const app = setup();
	await connectOnce(app);
	app.sockets[0].emit({ type: 'ready', device: app.session });
	cleanups.pop()!();
	await flush();
	assert.equal(app.events.size, 0);
	assert.equal(app.sockets[0].messages.length, 0);
	assertStopped(app);
});

const firstPhoto = new File(['first'], 'first.jpg');
const nextPhoto = new File(['next'], 'next.jpg');
test('adding photos validates the combined selection', async () => {
	const app = setup();
	await app.controller.select([firstPhoto]);
	await app.controller.addPhotos([nextPhoto]);
	assert.deepEqual(app.controller.selected, [firstPhoto, nextPhoto]);
	assert.deepEqual(app.dependencies.describePhotos.mock.lastCall, [[firstPhoto, nextPhoto]]);
});
test('invalid additions preserve the existing photos and metadata', async () => {
	const app = setup();
	await app.controller.select([firstPhoto]);
	rejectSelection(app);
	await app.controller.addPhotos([nextPhoto]);
	assert.deepEqual(app.controller.selected, [firstPhoto]);
	assert.deepEqual(app.controller.metadata, files);
	assert.match(app.controller.error, /10枚/);
});
test('cancelling the additional file picker preserves the selection', async () => {
	const app = setup();
	await app.controller.select([firstPhoto]);
	await app.controller.addPhotos([]);
	assert.deepEqual(app.controller.selected, [firstPhoto]);
	assert.equal(app.dependencies.describePhotos.mock.calls.length, 1);
});
test('discard replaces old notices and clears errors', async () => {
	const app = setup();
	app.controller.revokeLink();
	const error = new Error('古いエラー');
	app.dependencies.describePhotos.mockRejectedValueOnce(error);
	await app.controller.select([firstPhoto]);
	app.controller.discard();
	assert.equal(app.controller.error, '');
	assert.match(app.controller.notice, /画面内の写真を削除しました/);
});

async function completeSender(app: PageFixture) {
	await app.controller.select([firstPhoto]);
	await app.controller.createLink();
	await ready(app);
	await requestTransfer(app);
	await emit(app, { type: 'ended', id: 'transfer', reason: 'complete' });
}

test('sharing the same photos after completion starts a fresh session', async () => {
	const app = setup();
	await completeSender(app);
	app.controller.restartSharing(true);
	await flush();
	assert.equal(app.sessions, 2);
	assert.equal(app.controller.completed, false);
	assert.deepEqual(app.controller.selected, [firstPhoto]);
});
test('choosing different photos clears the completed selection', async () => {
	const app = setup();
	await completeSender(app);
	app.controller.restartSharing(false);
	assert.equal(app.controller.completed, false);
	assert.deepEqual(app.controller.selected, []);
	assert.deepEqual(app.controller.metadata, []);
	assert.equal(app.sessions, 1);
});
test('a consumed invitation cannot be joined again after rejection', async () => {
	const app = setup({ token: 'b'.repeat(64) });
	await flush();
	await ready(app);
	await requestTransfer(app);
	app.controller.action('reject');
	await app.controller.joinLink();
	assert.equal(app.controller.invitationUsed, true);
	assert.equal(app.sessions, 1);
});

function rejectSelection(app: PageFixture) {
	app.dependencies.describePhotos.mockRejectedValueOnce(new Error('写真は10枚・合計50MBまで選べます。'));
}

async function startGroup(app: PageFixture) {
	await app.controller.select([firstPhoto]);
	await app.controller.createLink('group');
	await ready(app);
	await assertLinkCreated(app);
}

async function groupRequest(app: PageFixture) {
	await emit(app, {
		type: 'requested',
		id: 'group-transfer',
		...groupRequestFields(),
		from: app.session,
		to: { id: 'other', name: 'Other' },
		files
	});
}

for (const reason of ['complete', 'failed', 'disconnected', 'cancelled'] as const) {
	test(`group sender remains connected after an individual ${reason}`, async () => {
		const app = setup();
		await startGroup(app);
		await groupRequest(app);
		await emit(app, { type: 'ended', id: 'group-transfer', reason });
		assertGroupStillOpen(app);
	});
}

function assertGroupStillOpen(app: PageFixture) {
	assert.equal(app.controller.connection, 'online');
	assert.equal(app.sockets[0].closed, false);
	assert.notEqual(app.controller.shareLink, '');
	assert.equal(app.controller.request, undefined);
	assert.equal(app.controller.completed, false);
}

test('group request includes its mode and selected photos stay locked', async () => {
	const app = setup();
	await startGroup(app);
	assertGroupCreation(app);
	app.controller.removePhoto(0);
	assert.equal(app.controller.selected.length, 1);
});
test('group receiver consent waits without opening a peer and failure permits retry', async () => {
	const app = setup({ token: 'b'.repeat(64) });
	await flush();
	await ready(app);
	await incomingGroupRequest(app);
	app.controller.action('accept');
	assert.equal(app.controller.phase, 'queued');
	await emit(app, { type: 'ended', id: 'group-transfer', reason: 'failed' });
	assertGroupRetry(app);
});

async function incomingGroupRequest(app: PageFixture) {
	await emit(app, {
		type: 'requested',
		id: 'group-transfer',
		...groupRequestFields(),
		from: { id: 'sender', name: 'Sender' },
		to: app.session,
		files
	});
}

function assertGroupRetry(app: PageFixture) {
	assert.equal(app.controller.connection, 'online');
	app.controller.retryGroup();
	assert.deepEqual(app.sockets[0].messages.at(-1), {
		type: 'join-link',
		token: 'b'.repeat(64)
	});
}

function groupRequestFields() {
	return { group: true, expiresAt: Date.now() + LIMITS.linkMs };
}

function assertGroupCreation(app: PageFixture) {
	assert.deepEqual(app.sockets[0].messages[0], {
		type: 'create-link',
		mode: 'group',
		files
	});
}

test('group ICE failure reports only that transfer and preserves the sender session', async () => {
	const app = setup();
	await startGroup(app);
	await groupRequest(app);
	app.dependencies.fetch.mockRejectedValue(new Error('ICE failure'));
	await emit(app, { type: 'start', id: 'group-transfer' });
	await vi.waitFor(() => assertGroupStillOpen(app));
	assertGroupFailure(app);
});

function assertGroupFailure(app: PageFixture) {
	assert.deepEqual(app.sockets[0].messages.at(-1), {
		type: 'fail',
		id: 'group-transfer'
	});
}

class FakeTransfer {
	peer = { close: vi.fn(), receive: vi.fn(async () => {}) };
	receiver = { dispose: vi.fn() };
	config?: IceConfig;

	constructor(readonly args: Parameters<TransferFactory>) {}

	get callbacks() {
		return this.args[3];
	}

	async connect(config: IceConfig) {
		this.config = config;
		this.callbacks.peer(this.peer);
		this.callbacks.receiver(this.receiver);
	}
}

function mockIce(app: PageFixture) {
	app.dependencies.fetch.mockImplementation(async () => Response.json({ iceServers: [], relay: true }));
}

async function receiveRequest(app: PageFixture, group = false) {
	await emit(app, {
		type: 'requested',
		id: 'transfer',
		from: { id: 'sender', name: 'Sender' },
		to: app.session,
		files,
		...(group ? groupRequestFields() : {})
	});
}

async function startReceiver() {
	const app = setup({ token: 'b'.repeat(64) });
	await flush();
	await ready(app);
	await receiveRequest(app);
	mockIce(app);
	await emit(app, { type: 'start', id: 'transfer' });
	await vi.waitFor(() => expect(app.transfers).toHaveLength(1));
	return app;
}

async function completedReceiver() {
	const app = await startReceiver();
	app.transfers[0].callbacks.received(firstPhoto);
	app.transfers[0].callbacks.complete();
	await emit(app, { type: 'ended', id: 'transfer', reason: 'complete' });
	return app;
}

test('starting a receiver connects ICE and updates progress and view callbacks', async () => {
	const app = await startReceiver();
	const transfer = app.transfers[0];
	transfer.callbacks.open();
	transfer.callbacks.progress(8);
	expect(app.controller.phase).toBe('transferring');
	expect(app.controller.bytes).toBe(8);
	expect(app.controller.relay).toBe(true);
	assertTransferCallbacks(app, transfer);
});

function assertTransferCallbacks(app: PageFixture, transfer: FakeTransfer) {
	expect(transfer.args[2]).toBe(false);
	expect(transfer.callbacks.total).toBe(8);
	expect(transfer.callbacks.bytes()).toBe(8);
	expect(transfer.callbacks.completed()).toBe(false);
	expect(app.controller.session).toEqual(app.session);
	expect(app.view.showTransfer).toHaveBeenCalledOnce();
}

test('transfer messages are matched by ID and forwarded to the active peer', async () => {
	const app = await startReceiver();
	const signal = { description: { type: 'offer' as const, sdp: 'remote' } };
	await emit(app, { type: 'signal', id: 'other', signal });
	expect(app.transfers[0].peer.receive).not.toHaveBeenCalled();
	await emit(app, { type: 'signal', id: 'transfer', signal });
	expect(app.transfers[0].peer.receive).toHaveBeenCalledWith(signal);
});
test('completion retains photos, closes transport and shows received photos', async () => {
	const app = await completedReceiver();
	expect(app.controller.received[0].file).toBe(firstPhoto);
	expect(app.controller.completed).toBe(true);
	expect(app.controller.photosExpireAt).toBeGreaterThan(Date.now());
	await vi.waitFor(() => expect(app.view.showReceived).toHaveBeenCalledOnce());
	assertTransportClosed(app);
});

function assertTransportClosed(app: PageFixture) {
	expect(app.transfers[0].peer.close).toHaveBeenCalledOnce();
	expect(app.transfers[0].receiver.dispose).toHaveBeenCalledOnce();
	expect(app.transfers[0].args[1].aborted).toBe(true);
}

test.each(['shared', 'cancelled', 'unsupported'] as const)('saving received photos reports %s', async (result) => {
	const app = await completedReceiver();
	app.dependencies.sharePhotos.mockResolvedValue(result);
	await app.controller.save();
	expect(app.dependencies.sharePhotos).toHaveBeenCalledWith([firstPhoto]);
	expect(app.controller.sharing).toBe(false);
	expect(app.controller.notice).toContain(saveNotices[result]);
});
const saveNotices = {
	shared: '写真アプリ',
	cancelled: 'キャンセル',
	unsupported: '1枚ずつダウンロード'
};
test('saving failure preserves received photos and clears the busy state', async () => {
	const app = await completedReceiver();
	app.dependencies.sharePhotos.mockRejectedValue(new Error('sharing failed'));
	await app.controller.save();
	expect(app.controller.error).toContain('各写真のダウンロード');
	expect(app.controller.received).toHaveLength(1);
	expect(app.controller.sharing).toBe(false);
});
test('a share finishing after discard cannot restore an old notice', async () => {
	const app = await completedReceiver();
	const pending = Promise.withResolvers<'shared'>();
	app.dependencies.sharePhotos.mockReturnValue(pending.promise);
	const saving = app.controller.save();
	app.controller.discard();
	pending.resolve('shared');
	await saving;
	expect(app.controller.notice).toContain('画面内の写真を削除');
});
test('photo expiry clears the controller view and prevents further sharing', async () => {
	const app = await completedReceiver();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.now() + PHOTO_LIFETIME_MS);
	expect(app.controller.checkPhotoExpiry()).toBe(false);
	await app.controller.save();
	expect(app.controller.received).toEqual([]);
	expect(app.controller.completed).toBe(false);
	expect(app.controller.notice).toContain('10分');
});
test('completed photos survive socket loss before the server completion message', async () => {
	const app = await startReceiver();
	app.transfers[0].callbacks.received(firstPhoto);
	app.transfers[0].callbacks.complete();
	app.sockets[0].disconnected();
	expect(app.controller.connection).toBe('offline');
	expect(app.controller.received).toHaveLength(1);
	expect(app.controller.photosExpireAt).toBeDefined();
});
test('unfinished photos are discarded when a transport fails', async () => {
	const app = await startReceiver();
	app.transfers[0].callbacks.received(firstPhoto);
	app.transfers[0].callbacks.fail('unknown failure');
	expect(app.controller.error).toContain('処理に失敗');
	expect(app.controller.received).toEqual([]);
	expectLastAction(app, 'cancel');
});
test('unsaved completed photos reject a second incoming request', async () => {
	const app = await startReceiver();
	app.transfers[0].callbacks.received(firstPhoto);
	app.transfers[0].callbacks.complete();
	await receiveRequest(app);
	expectLastAction(app, 'reject');
	expect(app.controller.notice).toContain('前に受け取った写真');
	expect(app.controller.received).toHaveLength(1);
});
test('failed photo previews fall back without affecting absent photos', async () => {
	const app = await completedReceiver();
	app.controller.previewFailed(0);
	app.controller.previewFailed(9);
	expect(app.controller.received[0].preview).toBe(false);
});
test.each([undefined, 'ICE unavailable'])('ICE HTTP failures expose a useful error: %s', async (error) => {
	const app = setup();
	await connectOnce(app);
	await requestTransfer(app);
	mockIceFailure(app, error);
	await emit(app, { type: 'start', id: 'transfer' });
	await vi.waitFor(() => expect(app.controller.connection).toBe('offline'));
	expect(app.controller.error).toBe(error ?? '接続の準備に失敗しました。');
});
test('late ICE responses cannot recreate a cancelled transfer', async () => {
	const app = setup();
	await connectOnce(app);
	await requestTransfer(app);
	await assertLateIceIgnored(app);
});

async function assertLateIceIgnored(app: PageFixture) {
	const pending = Promise.withResolvers<Response>();
	app.dependencies.fetch.mockReturnValue(pending.promise);
	app.sockets[0].emit({ type: 'start', id: 'transfer' });
	await flush();
	app.controller.action('cancel');
	pending.resolve(iceResponse());
	await flush();
	expect(app.transfers).toEqual([]);
}

test('share and copy invitation use browser APIs', async () => {
	const app = setup();
	await startGroup(app);
	const share = vi.fn<(data: ShareData) => Promise<void>>(async () => {});
	vi.stubGlobal('navigator', { share });
	await app.controller.shareInvitation();
	expect(share.mock.calls[0][0].url).toBe(app.controller.shareLink);
	await assertCopyInvitation(app);
});

async function assertCopyInvitation(app: PageFixture) {
	const writeText = vi.fn(async () => {});
	vi.stubGlobal('navigator', { clipboard: { writeText } });
	await app.controller.shareInvitation();
	expect(writeText).toHaveBeenCalledWith(app.controller.shareLink);
	expect(app.controller.notice).toContain('コピーしました');
}

test.each([new Error('failed'), new DOMException('cancelled', 'AbortError')])('invitation share handles %s', async (error) => {
	const app = setup();
	vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(error) });
	await app.controller.shareInvitation();
	expect(app.controller.error).toBe(
		error.name === 'AbortError' ? '' : '共有できませんでした。リンクをコピーして送ってください。'
	);
});
test('clipboard rejection offers manual copy guidance', async () => {
	const app = setup();
	vi.stubGlobal('navigator', {
		clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) }
	});
	await app.controller.copyInvitation();
	expect(app.controller.error).toContain('表示されたリンク');
});
test('unsupported browsers fail before creating a session', async () => {
	const app = setup();
	window.isSecureContext = false;
	await app.controller.select([firstPhoto]);
	await app.controller.createLink();
	expect(app.sessions).toBe(0);
	expect(app.controller.error).toContain('このブラウザでは');
});
test('session failures reset the busy state', async () => {
	const app = setup();
	app.dependencies.createSession.mockRejectedValueOnce(new Error('session unavailable'));
	await app.controller.select([firstPhoto]);
	await app.controller.createLink();
	expect(app.controller.creatingLink).toBe(false);
	expect(app.controller.error).toBe('session unavailable');
});
test('group actions send approval and cancellation without ending the link', async () => {
	const app = setup();
	await startGroup(app);
	app.controller.groupAction('approve', 'participant');
	app.controller.groupAction('cancel', 'participant');
	expectGroupActions(app);
	expect(app.controller.groupMode).toBe(true);
});
test('group server errors leave the distribution link usable', async () => {
	const app = setup();
	await startGroup(app);
	await emit(app, { type: 'error', message: 'recipient limit' });
	expect(app.controller.error).toBe('recipient limit');
	assertGroupStillOpen(app);
});
test('group participants still waiting are declined when the link ends', async () => {
	const app = setup();
	await startGroup(app);
	await emitParticipants(app);
	await emit(app, { type: 'link-ended' });
	const statuses = app.controller.participants.map((p) => p.status);
	expect(statuses).toEqual(['declined', 'complete']);
	expect(app.controller.error).toContain('有効期限');
});

async function emitParticipants(app: PageFixture) {
	await emit(app, {
		type: 'group-state',
		participants: [participant('one', 'waiting'), participant('two', 'complete')]
	});
}

test('group retry is ignored before joining or while a transfer is active', async () => {
	const app = setup({ token: 'b'.repeat(64) });
	await flush();
	await ready(app);
	await incomingGroupRequest(app);
	const count = app.sockets[0].messages.length;
	app.controller.retryGroup();
	expect(app.controller.groupReceiver).toBe(true);
	expect(app.sockets[0].messages).toHaveLength(count);
});
test('accepting a single transfer waits for the server start message', async () => {
	const app = setup();
	await connectOnce(app);
	await requestTransfer(app);
	app.controller.action('accept');
	expect(app.controller.phase).toBe('connecting');
	expect(app.transfers).toEqual([]);
});
test('control setup times out when the server does not create a link', async () => {
	vi.useFakeTimers();
	const app = setup();
	await connectOnce(app);
	await ready(app);
	vi.advanceTimersByTime(10_000);
	expect(app.controller.error).toContain('準備に時間がかかっています');
});
test('approval and transfer inactivity have separate deadlines', async () => {
	vi.useFakeTimers();
	const app = setup();
	await connectOnce(app);
	await requestTransfer(app);
	vi.advanceTimersByTime(LIMITS.requestMs + 1000);
	expect(app.controller.error).toContain('確認する時間が過ぎました');
});
test('receiving progress resets the transfer watchdog', async () => {
	vi.useFakeTimers();
	const app = await startReceiver();
	app.transfers[0].callbacks.progress(4);
	vi.advanceTimersByTime(59_999);
	expect(app.controller.error).toBe('');
	vi.advanceTimersByTime(1);
	expect(app.controller.error).toContain('転送が止まりました');
});
test('new selections with a non-Error failure retain a helpful message', async () => {
	const app = setup();
	app.dependencies.describePhotos.mockRejectedValueOnce('invalid');
	await app.controller.select([firstPhoto]);
	expect(app.controller.error).toBe('写真を選び直してください。');
	expect(app.controller.selecting).toBe(false);
});

function expectLastAction(app: PageFixture, type: string) {
	expect(app.sockets[0].messages.at(-1)).toEqual({ type, id: 'transfer' });
}

function mockIceFailure(app: PageFixture, error?: string) {
	app.dependencies.fetch.mockImplementation(async () => Response.json({ error }, { status: 503 }));
}

function iceResponse() {
	const response = new Response();
	vi.spyOn(response, 'json').mockResolvedValue({
		iceServers: [],
		relay: false
	});
	return response;
}

function expectGroupActions(app: PageFixture) {
	expect(app.sockets[0].messages.slice(-2)).toEqual([
		{ type: 'approve', id: 'participant' },
		{ type: 'cancel', id: 'participant' }
	]);
}

type ParticipantStatus = GroupParticipant['status'];

function participant(id: string, status: ParticipantStatus): GroupParticipant {
	return {
		id,
		device: { id, name: id },
		status,
		approved: false,
		accepted: false,
		attempts: 1
	};
}
