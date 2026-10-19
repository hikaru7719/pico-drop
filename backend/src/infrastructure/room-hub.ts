import { RoomService } from '../application/room.ts';
import { roomApp } from '../api/room.ts';
import { authJson } from '../api/http.ts';
import { identity, allowSend } from './hub-network.ts';
import { iceServers } from './turn.ts';
import type { Bindings } from './bindings.ts';
export class RoomHub extends RoomService {
	constructor(
		private state: DurableObjectState,
		env: Bindings
	) {
		super(runtime(state), {
			identity: (key) => identity(env, key),
			allowSend: (key) => allowSend(env, key),
			iceServers: () => iceServers(env)
		});
	}

	fetch(request: Request) {
		return roomApp(this, () => this.upgradeSocket()).fetch(request);
	}

	async upgradeSocket() {
		if (this.state.getWebSockets().length >= 200) {
			return authJson({ error: '混み合っています。後でお試しください。' }, 503);
		}
		return this.acceptSocket();
	}

	private async acceptSocket() {
		const pair = new WebSocketPair();
		this.state.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment({ connectedAt: Date.now() });
		await this.schedule();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
}

function runtime(state: DurableObjectState) {
	return {
		storage: state.storage,
		getRoomSockets: () => state.getWebSockets(),
		blockConcurrencyWhile: <T>(callback: () => Promise<T>) => state.blockConcurrencyWhile(callback)
	};
}
