import { api, createApi, readJson } from '../api';
import type { ClientMessage, ServerMessage, Session } from '../../../../shared/protocol.ts';
export interface SignalingConnection {
	send(message: ClientMessage): void;
	close(): void;
}
export interface SignalingSocket extends Pick<
	WebSocket,
	'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'readyState' | 'close'
> {
	send(message: string): void;
}
export interface SocketFactory {
	(url: URL): SignalingSocket;
}

const browserSocket: SocketFactory = (url) => new WebSocket(url);

export class Signaling implements SignalingConnection {
	private ws: SignalingSocket;
	private timer: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		session: Session,
		onMessage: (message: ServerMessage) => void,
		onClose: () => void,
		openSocket: SocketFactory = browserSocket
	) {
		this.ws = openSocket(socketUrl(session.room));
		this.timer = setTimeout(() => this.ws.close(), 10_000);
		this.listen(session, onMessage, onClose);
	}

	private listen(session: Session, onMessage: (message: ServerMessage) => void, onClose: () => void) {
		this.ws.onopen = () => this.send({ type: 'auth', token: session.token });
		this.ws.onmessage = (event) => this.receive(event, onMessage);
		this.ws.onerror = () => this.ws.close();
		this.ws.onclose = () => this.disconnected(onClose);
	}

	private receive(event: MessageEvent, onMessage: (message: ServerMessage) => void) {
		try {
			onMessage(this.parse(event));
		} catch {
			this.ws.close();
		}
	}

	private parse(event: MessageEvent): ServerMessage {
		const message = JSON.parse(event.data) as ServerMessage;
		if (message.type === 'ready') {
			clearTimeout(this.timer);
		}
		return message;
	}

	private disconnected(onClose: () => void) {
		clearTimeout(this.timer);
		if (!this.closed) {
			onClose();
		}
	}

	send(message: ClientMessage) {
		if (this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('接続が切れています。再接続してください。');
		}
		this.ws.send(JSON.stringify(message));
	}

	close() {
		this.closed = true;
		clearTimeout(this.timer);
		this.ws.close();
	}
}

export async function createSession(signal?: AbortSignal, token = '', request: typeof fetch = fetch) {
	const query = token ? { room: token.slice(0, 16) } : {};
	const client = createApi(request);
	const response = await client.session.$post({ query }, { init: { signal } });
	return readJson(response, '接続に失敗しました。');
}

function socketUrl(room?: string) {
	const url = new URL(api.ws.$path({ query: room ? { room } : {} }), location.href);
	url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return url;
}
