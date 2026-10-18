import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { LIMITS, type ServerMessage } from '../../../../shared/protocol.ts';
import { createDropController } from './controller.svelte';
import { createSession, Signaling } from '../webrtc/signaling';
import { describePhotos } from '../photos';

vi.mock('../webrtc/signaling', () => ({
	createSession: vi.fn(),
	Signaling: vi.fn()
}));
vi.mock('../photos', () => ({ describePhotos: vi.fn(), sharePhotos: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

type SetupOptions = { pendingSession?: boolean; token?: string };
class FakeSocket {
	closed = false;
	messages: unknown[] = [];
	constructor(public emit: (message: ServerMessage) => void) {}
	send(message: ServerMessage) {
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
	resolvePending: (value: unknown) => void = () => {};
	session = {
		id: 'self',
		name: 'Self',
		token: 'token',
		expiresAt: 9999999999999
	};
	controller: ReturnType<typeof createDropController>;
	constructor(private options: SetupOptions) {
		vi.stubGlobal('window', this.window());
		vi.mocked(createSession).mockImplementation(
			(signal) => this.createSession(signal!) as Promise<typeof this.session>
		);
		this.mockSignaling();
		vi.mocked(describePhotos).mockResolvedValue(files);
		this.controller = createDropController();
		cleanups.push(this.controller.mount());
	}
	mockSignaling() {
		const Socket = this.signaling();
		vi.mocked(Signaling).mockImplementation(function (...args) {
			return new Socket(args[0], args[1]) as unknown as Signaling;
		});
	}

	window() {
		return {
			isSecureContext: true,
			location: this.location(),
			RTCPeerConnection: class {},
			addEventListener: (name: string, callback: () => void) =>
				this.events.set(name, callback),
			removeEventListener: (name: string) => this.events.delete(name)
		};
	}
	location() {
		return {
			origin: 'https://example.com',
			hash: this.options.token ? '#share=' + this.options.token : ''
		};
	}

	signaling() {
		const sockets = this.sockets;
		return class extends FakeSocket {
			constructor(_session: unknown, emit: (message: ServerMessage) => void) {
				super(emit);
				sockets.push(this);
			}
		};
	}
	async createSession(signal: AbortSignal) {
		this.sessions++;
		this.sessionSignal = signal;
		return this.options.pendingSession
			? new Promise((resolve) => {
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
	assert.deepEqual(vi.mocked(describePhotos).mock.lastCall, [
		[firstPhoto, nextPhoto]
	]);
});
test('invalid additions preserve the existing photos and metadata', async () => {
	const app = setup();
	await app.controller.select([firstPhoto]);
	rejectSelection();
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
	assert.equal(vi.mocked(describePhotos).mock.calls.length, 1);
});
test('discard replaces old notices and clears errors', async () => {
	const app = setup();
	app.controller.revokeLink();
	vi.mocked(describePhotos).mockRejectedValueOnce(new Error('古いエラー'));
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

function rejectSelection() {
	vi.mocked(describePhotos).mockRejectedValueOnce(
		new Error('写真は10枚・合計50MBまで選べます。')
	);
}
