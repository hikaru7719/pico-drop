import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
	createSession,
	Signaling,
	type SignalingSocket,
	type SocketFactory
} from './signaling';
import type { ServerMessage } from '../../../../shared/protocol.ts';

class Socket implements SignalingSocket {
	readyState: SignalingSocket['readyState'] = WebSocket.OPEN;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	send = vi.fn<SignalingSocket['send']>();
	close = vi.fn<SignalingSocket['close']>();
	message(data: string) {
		this.onmessage!(new MessageEvent('message', { data }));
	}
}
const session = {
	id: 'self',
	name: 'Self',
	token: 'secret',
	expiresAt: 10000,
	room: 'room'
};
const connections: Signaling[] = [];
class Fixture {
	socket = new Socket();
	open = vi.fn<SocketFactory>(() => this.socket);
	message = vi.fn<(message: ServerMessage) => void>();
	closed = vi.fn<() => void>();
	signaling: Signaling;
	constructor(room: string | undefined = session.room) {
		this.signaling = new Signaling(
			{ ...session, room },
			this.message,
			this.closed,
			this.open
		);
		connections.push(this.signaling);
	}
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('location', new URL('https://photos.example/'));
});
afterEach(() => {
	connections.splice(0).forEach((connection) => connection.close());
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test('socket authentication uses the session token and secure room URL', () => {
	const f = new Fixture();
	expect(f.open.mock.calls[0][0].href).toBe(
		'wss://photos.example/api/ws?room=room'
	);
	f.socket.onopen!();
	expect(f.socket.send).toHaveBeenCalledExactlyOnceWith(
		'{"type":"auth","token":"secret"}'
	);
});
test('local HTTP sessions use ws and omit absent rooms', () => {
	vi.stubGlobal('location', new URL('http://localhost/'));
	const f = new Fixture('');
	expect(f.open.mock.calls[0][0].href).toBe('ws://localhost/api/ws');
});
test('ready clears the connection timeout and forwards messages', () => {
	const f = new Fixture();
	const ready: ServerMessage = { type: 'ready', device: session };
	f.socket.message(JSON.stringify(ready));
	f.socket.message('{"type":"error","message":"denied"}');
	vi.advanceTimersByTime(10000);
	expect(f.socket.close).not.toHaveBeenCalled();
	const types = f.message.mock.calls.map(([message]) => message.type);
	expect(types).toEqual(['ready', 'error']);
});
test('a socket that never becomes ready is closed after ten seconds', () => {
	const f = new Fixture();
	vi.advanceTimersByTime(9999);
	expect(f.socket.close).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(f.socket.close).toHaveBeenCalledOnce();
});
test.each(['bad JSON', 'null'])(
	'invalid incoming %s closes the socket',
	(data) => {
		const f = new Fixture();
		f.socket.message(data);
		expect(f.socket.close).toHaveBeenCalledOnce();
		expect(f.message).not.toHaveBeenCalled();
	}
);
test('socket errors close the connection and an unexpected close notifies its owner', () => {
	const f = new Fixture();
	f.socket.onerror!();
	f.socket.onclose!();
	expect(f.socket.close).toHaveBeenCalledOnce();
	expect(f.closed).toHaveBeenCalledOnce();
	vi.advanceTimersByTime(10000);
	expect(f.socket.close).toHaveBeenCalledOnce();
});
test('explicit close cancels the timer without notifying the owner', () => {
	const f = new Fixture();
	f.signaling.close();
	f.socket.onclose!();
	vi.advanceTimersByTime(10000);
	expect(f.closed).not.toHaveBeenCalled();
	expect(f.socket.close).toHaveBeenCalledOnce();
});
test('sending on a closed socket fails without writing', () => {
	const f = new Fixture();
	f.socket.readyState = WebSocket.CLOSED;
	expect(() => f.signaling.send({ type: 'revoke-link' })).toThrow('再接続');
	expect(f.socket.send).not.toHaveBeenCalled();
});
test.each(['', 'a'.repeat(64)])(
	'session request propagates cancellation and token routing: %s',
	async (token) => {
		const request = sessionRequest();
		const signal = new AbortController().signal;
		expect(await createSession(signal, token, request)).toEqual(session);
		const suffix = token ? '?room=' + token.slice(0, 16) : '';
		expect(request).toHaveBeenCalledExactlyOnceWith('/api/session' + suffix, {
			method: 'POST',
			signal
		});
	}
);
test.each([{}, { error: 'denied' }])(
	'session HTTP errors use a useful message: %j',
	async (body) => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json(body, { status: 403 }));
		await expect(createSession(undefined, '', request)).rejects.toThrow(
			body.error ?? '接続に失敗しました。'
		);
	}
);

function sessionRequest() {
	return vi.fn<typeof fetch>().mockResolvedValue(Response.json(session));
}
