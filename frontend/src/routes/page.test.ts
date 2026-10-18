import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { compileModule } from 'svelte/compiler';
import { LIMITS } from '../../../shared/protocol.ts';

// Exercise the actual page controller with Svelte's reactive state and mocked I/O.
const page = await readFile(new URL('./+page.svelte', import.meta.url), 'utf8');
const script = page
	.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]
	.replace(/\bimport\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?/g, '');
const source = `export function createPage(deps) {
const { LIMITS, onMount, tick, createSession, Signaling, window } = deps;
${stripTypeScriptTypes(script, { mode: 'transform' })}
return { createLink, joinLink, revokeLink, handle, action,
setPhotos(files) { metadata = files; },
get state() { return { connection, session, completed, received, error, shareLink, creatingLink, incomingToken }; } };
}`;
const compiled = compileModule(source, {
	filename: 'connection-controller.svelte.js',
	generate: 'client'
}).js.code.replace(
	/from ['"](svelte\/[^'"]+)['"]/g,
	(_, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`
);
const { createPage } = await import(
	`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

type SetupOptions = { pendingSession?: boolean; token?: string };
class FakeSocket {
	closed = false;
	messages: unknown[] = [];
	constructor(public emit: (message: unknown) => void) {}
	send(message: unknown) {
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
	mount: () => void = () => {};
	session = {
		id: 'self',
		name: 'Self',
		token: 'token',
		expiresAt: 9999999999999
	};
	controller: ReturnType<typeof createPage>;
	constructor(private options: SetupOptions) {
		this.controller = createPage(this.dependencies());
		this.mount();
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
			constructor(_session: unknown, emit: (message: unknown) => void) {
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
	io() {
		return {
			window: this.window(),
			Signaling: this.signaling(),
			createSession: (signal: AbortSignal) => this.createSession(signal)
		};
	}
	dependencies() {
		return { ...this.io(), ...this.lifecycle(), LIMITS, tick: async () => {} };
	}
	lifecycle() {
		return {
			onMount: (callback: () => void) => {
				this.mount = callback;
			}
		};
	}
}
const setup = (options: SetupOptions = {}) => new PageFixture(options);
const flush = async () => {
	for (let i = 0; i < 12; i++) {
		await Promise.resolve();
	}
};

function assertIdle(app: PageFixture) {
	assert.equal(app.controller.state.connection, 'idle');
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
	app.controller.setPhotos(files);
	await Promise.all([app.controller.createLink(), app.controller.createLink()]);
	assert.equal(app.sessions, 1);
	assert.equal(app.controller.state.connection, 'connecting');
	assert.equal(app.sockets[0].messages.length, 0);
}
async function ready(app: PageFixture) {
	app.sockets[0].emit({ type: 'ready' });
	await flush();
}
function assertStopped(app: PageFixture) {
	assert.equal(app.sockets[0].closed, true);
	assert.equal(app.controller.state.connection, 'idle');
}
test('authentication creates a link without requesting location; revocation closes signaling', async () => {
	const app = setup();
	await connectOnce(app);
	await ready(app);
	assert.deepEqual(app.sockets[0].messages, [{ type: 'create-link', files }]);
	await assertLinkCreated(app);
	app.controller.revokeLink();
	assertStopped(app);
	assert.equal(app.controller.state.shareLink, '');
});
async function assertLinkCreated(app: PageFixture) {
	await app.controller.handle({
		type: 'link-created',
		token: 'a'.repeat(64),
		expiresAt: Date.now() + LIMITS.linkMs
	});
	const expected = 'https://example.com/#share=' + 'a'.repeat(64);
	assert.equal(app.controller.state.shareLink, expected);
}
test('stopping an in-flight session request prevents a late WebSocket connection', async () => {
	const app = setup({ pendingSession: true });
	app.controller.setPhotos(files);
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
	await app.controller.handle({ type: 'error', message: '期限切れ' });
	assert.equal(app.controller.state.error, '期限切れ');
	app.controller.revokeLink();
});
async function requestTransfer(app: PageFixture) {
	await app.controller.handle({
		type: 'requested',
		id: 'transfer',
		from: app.session,
		to: { id: 'other', name: 'Other' },
		files
	});
}
for (const reason of ['complete', 'cancelled']) {
	test(`transfer ${reason} closes signaling and clears link`, async () => {
		const app = setup();
		await connectOnce(app);
		await ready(app);
		await requestTransfer(app);
		await app.controller.handle({ type: 'ended', id: 'transfer', reason });
		assertStopped(app);
		assert.equal(app.controller.state.completed, reason === 'complete');
	});
}

test('invalid invitation does not create a session', async () => {
	const app = setup({ token: 'invalid' });
	await flush();
	assertIdle(app);
	assert.match(app.controller.state.error, /共有リンクが正しくありません/);
});
