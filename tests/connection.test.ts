import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { compileModule } from 'svelte/compiler';
import { LIMITS } from '../shared/protocol.ts';

// Exercise the actual page controller with Svelte's reactive state and mocked I/O.
const page = await readFile(
	new URL('../frontend/src/routes/+page.svelte', import.meta.url),
	'utf8'
);
const script = page
	.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]
	.replace(/\bimport\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?/g, '');
const source = `export function createPage(deps) {
const { LIMITS, onMount, tick, createSession, Signaling, locate, window, setInterval, clearInterval } = deps;
${stripTypeScriptTypes(script, { mode: 'transform' })}
return { startDiscovery, stopDiscovery, handle, action,
get state() { return { connection, searching, discovering, session, completed, received, error }; } };
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

type SetupOptions = { pendingSession?: boolean; locationError?: boolean };
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
	intervals = 0;
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
			RTCPeerConnection: class {},
			matchMedia: () => ({ matches: true }),
			addEventListener: (name: string, callback: () => void) =>
				this.events.set(name, callback),
			removeEventListener: (name: string) => this.events.delete(name)
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
	async locate() {
		if (this.options.locationError) {
			throw new Error('Location denied');
		}
		return { latitude: 35, longitude: 139, accuracy: 10 };
	}
	setInterval() {
		this.intervals++;
		return 1;
	}
	clearInterval(timer: unknown) {
		if (timer !== undefined) {
			this.intervals--;
		}
	}
	io() {
		return {
			window: this.window(),
			Signaling: this.signaling(),
			locate: () => this.locate(),
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
			},
			setInterval: () => this.setInterval(),
			clearInterval: (timer: unknown) => this.clearInterval(timer)
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
void test('opening and restoring the page do not contact signaling', async () => {
	const app = setup();
	await flush();
	assertIdle(app);
	app.events.get('pagehide')!();
	app.events.get('pageshow')!({ persisted: true });
	await flush();
	assertIdle(app);
});
async function connectOnce(app: PageFixture) {
	await Promise.all([
		app.controller.startDiscovery(),
		app.controller.startDiscovery()
	]);
	assert.equal(app.sessions, 1);
	assert.equal(app.controller.state.connection, 'connecting');
	assert.equal(app.sockets[0].messages.length, 0);
}
async function discover(app: PageFixture) {
	app.sockets[0].emit({ type: 'ready' });
	await flush();
	assert.equal(app.controller.state.discovering, true);
	assert.equal(app.intervals, 1);
	assert.equal(
		(app.sockets[0].messages[0] as { type: string }).type,
		'presence'
	);
}
function assertStopped(app: PageFixture) {
	assert.equal(app.sockets[0].closed, true);
	assert.equal(app.controller.state.connection, 'idle');
	assert.equal(app.intervals, 0);
}
void test('one click connects, authentication starts discovery, stop closes and restart reconnects', async () => {
	const app = setup();
	await connectOnce(app);
	await discover(app);
	app.controller.stopDiscovery();
	assertStopped(app);
	await app.controller.startDiscovery();
	assert.equal(app.sessions, 2);
	app.controller.stopDiscovery();
});
void test('stopping an in-flight session request prevents a late WebSocket connection', async () => {
	const app = setup({ pendingSession: true });
	const pending = app.controller.startDiscovery();
	app.controller.stopDiscovery();
	assert.equal(app.sessionSignal?.aborted, true);
	app.resolveSession();
	await pending;
	assert.equal(app.sockets.length, 0);
	assert.equal(app.controller.state.connection, 'idle');
});
void test('location denial closes the connection and leaves discovery retryable', async () => {
	const app = setup({ locationError: true });
	await app.controller.startDiscovery();
	app.sockets[0].emit({ type: 'ready' });
	await flush();
	assertStopped(app);
	assert.equal(app.controller.state.searching, false);
});
async function requestTransfer(app: PageFixture) {
	await app.controller.handle({
		type: 'requested',
		id: 'transfer',
		from: app.session,
		to: { id: 'other', name: 'Other' },
		files: []
	});
}
for (const reason of ['complete', 'cancelled']) {
	void test(`transfer ${reason} closes signaling and stops discovery`, async () => {
		const app = setup();
		await app.controller.startDiscovery();
		await discover(app);
		await requestTransfer(app);
		await app.controller.handle({ type: 'ended', id: 'transfer', reason });
		assertStopped(app);
		assert.equal(app.controller.state.completed, reason === 'complete');
	});
}
