import { DurableObject } from 'cloudflare:workers';
import type { Bindings } from './bindings.ts';
import { RoomHub } from './room-hub.ts';

export class RoomObject extends DurableObject<Bindings> {
	private room() {
		return new RoomHub(this.ctx, this.env);
	}

	async fetch(request: Request) {
		return this.room().fetch(request);
	}

	async consumePhoto(token: string, id: string, mode: string) {
		return this.room().consumePhoto(token, id, mode);
	}

	async revokePhoto(token: string) {
		return this.room().revokePhoto(token);
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		return this.room().webSocketMessage(ws, raw);
	}

	async webSocketClose(ws: WebSocket) {
		return this.room().webSocketClose(ws);
	}

	async webSocketError(ws: WebSocket) {
		return this.room().webSocketError(ws);
	}

	async alarm() {
		await this.room().alarm();
	}
}
