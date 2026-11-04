import { DurableObject } from 'cloudflare:workers';
import { RoomService } from '../application/room.ts';
import type { RoomRuntime } from '../application/room-ports.ts';
import { roomApp } from '../api/room.ts';
import { authJson } from '../api/http.ts';
import { authentication } from './d1-auth.ts';
import { iceServers } from './turn.ts';
import type { Bindings } from './bindings.ts';

export class RoomObject extends DurableObject<Bindings> {
	private readonly auth = authentication(this.env);
	private readonly service = new RoomService(runtime(this.ctx), {
		identity: (key) => this.auth.identity(key),
		allowSend: (key) => this.auth.allowSend(key),
		iceServers: () => iceServers(this.env)
	});

	async fetch(request: Request) {
		return roomApp(this.service, () => this.upgradeSocket()).fetch(request);
	}

	private async upgradeSocket() {
		if (this.ctx.getWebSockets().length >= 200) {
			return authJson({ error: '混み合っています。後でお試しください。' }, 503);
		}
		return this.acceptSocket();
	}

	private async acceptSocket() {
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment({ connectedAt: Date.now() });
		await this.service.schedule();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async consumePhoto(token: string, id: string, mode: string) {
		return this.service.consumePhoto(token, id, mode);
	}

	async revokePhoto(token: string) {
		return this.service.revokePhoto(token);
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		return this.service.webSocketMessage(ws, raw);
	}

	async webSocketClose(ws: WebSocket) {
		return this.service.webSocketClose(ws);
	}

	async webSocketError(ws: WebSocket) {
		return this.service.webSocketError(ws);
	}

	async alarm() {
		await this.service.alarm();
	}
}

function runtime(state: DurableObjectState): RoomRuntime {
	return {
		storage: state.storage,
		getRoomSockets: () => state.getWebSockets(),
		blockConcurrencyWhile: <T>(callback: () => Promise<T>) => state.blockConcurrencyWhile(callback)
	};
}
