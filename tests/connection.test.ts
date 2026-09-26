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
${stripTypeScriptTypes(script)}
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

function setup(
	options: { pendingSession?: boolean; locationError?: boolean } = {}
) {
	const events = new Map<string, (event?: unknown) => void>();
	const sockets: {
		closed: boolean;
		messages: unknown[];
		emit: (message: unknown) => void;
	}[] = [];
	let sessions = 0;
	let sessionSignal: AbortSignal | undefined;
	let resolveSession: (value: unknown) => void = () => {};
	let intervals = 0;
	let mount: () => void = () => {};
	const session = {
		id: 'self',
		name: 'Self',
		token: 'token',
		expiresAt: 9999999999999
	};
	const controller = createPage({
		LIMITS,
		onMount: (callback: () => void) => {
			mount = callback;
		},
		tick: async () => {},
		window: {
			isSecureContext: true,
			RTCPeerConnection: class {},
			matchMedia: () => ({ matches: true }),
			addEventListener: (name: string, callback: () => void) =>
				events.set(name, callback),
			removeEventListener: (name: string) => events.delete(name)
		},
		createSession: async (signal: AbortSignal) => {
			sessions++;
			sessionSignal = signal;
			return options.pendingSession
				? new Promise((resolve) => {
						resolveSession = resolve;
					})
				: session;
		},
		Signaling: class {
			closed = false;
			messages: unknown[] = [];
			constructor(
				_session: unknown,
				public emit: (message: unknown) => void
			) {
				sockets.push(this);
			}
			send(message: unknown) {
				this.messages.push(message);
			}
			close() {
				this.closed = true;
			}
		},
		locate: async () => {
			if (options.locationError) throw new Error('Location denied');
			return { latitude: 35, longitude: 139, accuracy: 10 };
		},
		setInterval: () => {
			intervals++;
			return 1;
		},
		clearInterval: (timer: unknown) => {
			if (timer !== undefined) intervals--;
		}
	});
	mount();
	return {
		controller,
		sockets,
		events,
		session,
		get sessions() {
			return sessions;
		},
		get intervals() {
			return intervals;
		},
		get sessionSignal() {
			return sessionSignal;
		},
		resolveSession: () => resolveSession(session)
	};
}
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

test('opening and restoring the page do not contact signaling', async () => {
	const app = setup();
	await flush();
	assert.equal(app.controller.state.connection, 'idle');
	assert.equal(app.sessions, 0);
	app.events.get('pagehide')!();
	app.events.get('pageshow')!({ persisted: true });
	await flush();
	assert.equal(app.sessions, 0);
	assert.equal(app.sockets.length, 0);
});

test('one click connects, authentication starts discovery, stop closes and restart reconnects', async () => {
	const app = setup();
	await Promise.all([
		app.controller.startDiscovery(),
		app.controller.startDiscovery()
	]);
	assert.equal(app.sessions, 1);
	assert.equal(app.controller.state.connection, 'connecting');
	assert.equal(app.sockets[0].messages.length, 0);
	app.sockets[0].emit({ type: 'ready' });
	await flush();
	assert.equal(app.controller.state.discovering, true);
	assert.equal(app.intervals, 1);
	assert.equal(
		(app.sockets[0].messages[0] as { type: string }).type,
		'presence'
	);
	app.controller.stopDiscovery();
	assert.equal(app.sockets[0].closed, true);
	assert.equal(app.controller.state.connection, 'idle');
	assert.equal(app.intervals, 0);
	await app.controller.startDiscovery();
	assert.equal(app.sessions, 2);
	app.controller.stopDiscovery();
});

test('stopping an in-flight session request prevents a late WebSocket connection', async () => {
	const app = setup({ pendingSession: true });
	const pending = app.controller.startDiscovery();
	app.controller.stopDiscovery();
	assert.equal(app.sessionSignal?.aborted, true);
	app.resolveSession();
	await pending;
	assert.equal(app.sockets.length, 0);
	assert.equal(app.controller.state.connection, 'idle');
});

test('location denial closes the connection and leaves discovery retryable', async () => {
	const app = setup({ locationError: true });
	await app.controller.startDiscovery();
	app.sockets[0].emit({ type: 'ready' });
	await flush();
	assert.equal(app.sockets[0].closed, true);
	assert.equal(app.controller.state.connection, 'idle');
	assert.equal(app.controller.state.searching, false);
	assert.equal(app.intervals, 0);
});

for (const reason of ['complete', 'cancelled']) {
	test(`transfer ${reason} closes signaling and stops discovery`, async () => {
		const app = setup();
		await app.controller.startDiscovery();
		app.sockets[0].emit({ type: 'ready' });
		await flush();
		await app.controller.handle({
			type: 'requested',
			id: 'transfer',
			from: app.session,
			to: { id: 'other', name: 'Other' },
			files: [],
			confirmation: { kind: 'tell', word: 'さくら' }
		});
		await app.controller.handle({ type: 'ended', id: 'transfer', reason });
		assert.equal(app.sockets[0].closed, true);
		assert.equal(app.controller.state.connection, 'idle');
		assert.equal(app.controller.state.completed, reason === 'complete');
		assert.equal(app.intervals, 0);
	});
}
