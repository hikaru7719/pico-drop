import type { ClientMessage, ServerMessage, Session } from '../../../../shared/protocol.ts';
export class Signaling {
	private ws: WebSocket;
	private timer: ReturnType<typeof setTimeout>;
	private closed = false;
	constructor(session: Session, onMessage: (message: ServerMessage) => void, onClose: () => void) {
		const url = new URL('/api/ws', location.href);
		url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		this.ws = new WebSocket(url);
		this.timer = setTimeout(() => this.ws.close(), 10_000);
		this.ws.onopen = () => this.send({ type: 'auth', token: session.token });
		this.ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data) as ServerMessage;
				if (message.type === 'ready') clearTimeout(this.timer);
				onMessage(message);
			} catch {
				this.ws.close();
			}
		};
		this.ws.onerror = () => this.ws.close();
		this.ws.onclose = () => {
			clearTimeout(this.timer);
			if (!this.closed) onClose();
		};
	}
	send(message: ClientMessage) {
		if (this.ws.readyState !== WebSocket.OPEN)
			throw new Error('接続が切れています。再接続してください。');
		this.ws.send(JSON.stringify(message));
	}
	close() {
		this.closed = true;
		clearTimeout(this.timer);
		this.ws.close();
	}
}
export async function createSession(): Promise<Session> {
	const response = await fetch('/api/session', { method: 'POST' });
	const data = (await response.json()) as Session & { error?: string };
	if (!response.ok) throw new Error(data.error ?? '接続に失敗しました。');
	return data;
}
