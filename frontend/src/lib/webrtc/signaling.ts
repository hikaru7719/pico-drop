import type {
	ClientMessage,
	ServerMessage,
	Session
} from '../../../../shared/protocol.ts';
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
	private listen(
		session: Session,
		onMessage: (message: ServerMessage) => void,
		onClose: () => void
	) {
		this.ws.onopen = () => this.send({ type: 'auth', token: session.token });
		this.ws.onmessage = (event) => this.receive(event, onMessage);
		this.ws.onerror = () => this.ws.close();
		this.ws.onclose = () => this.disconnected(onClose);
	}

	private receive(
		event: MessageEvent,
		onMessage: (message: ServerMessage) => void
	) {
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
export async function createSession(
	signal?: AbortSignal,
	token = '',
	request: typeof fetch = fetch
) {
	const suffix = token ? '?room=' + token.slice(0, 16) : '';
	const init = { method: 'POST', signal };
	return readSession(await request('/api/session' + suffix, init));
}
async function readSession(response: Response): Promise<Session> {
	const data = (await response.json()) as Session & { error?: string };
	if (!response.ok) {
		throw new Error(data.error ?? '接続に失敗しました。');
	}
	return data;
}

function socketUrl(room?: string) {
	const url = new URL('/api/ws', location.href);
	if (room) {
		url.searchParams.set('room', room);
	}
	url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return url;
}
