import { DurableObject } from 'cloudflare:workers';
import type { AuthenticationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import type { Account, Ceremony } from '../domain/auth.ts';
import type { Bindings } from './bindings.ts';
import { AuthHub } from './auth-hub.ts';
import { RoomHub } from './room-hub.ts';
import { RateLimiter } from '../application/rate-limiter.ts';

type Role = 'auth' | 'room' | 'rate';
// Keep the deployed class/namespace and IDs stable; business logic belongs to the handlers.
export class NearbyHub extends DurableObject<Bindings> {
	private handler(role: 'auth'): Promise<AuthHub>;
	private handler(role: 'room'): Promise<RoomHub>;
	private handler(role: 'rate'): Promise<RateLimiter>;
	private async handler(role: Role) {
		if ((await this.ctx.storage.get('hub:role')) !== role) {
			await this.ctx.storage.put('hub:role', role);
		}
		return this.handlers()[role];
	}

	private handlers() {
		return {
			auth: new AuthHub(this.ctx, this.env),
			room: new RoomHub(this.ctx, this.env),
			rate: new RateLimiter(this.ctx)
		};
	}

	async fetch(request: Request) {
		return new URL(request.url).pathname.startsWith('/api/auth/')
			? (await this.handler('auth')).authRequest(request)
			: (await this.handler('room')).fetch(request);
	}

	async accountIdentity(key: string) {
		return (await this.handler('auth')).accountIdentity(key);
	}

	async authorizeSend(key: string) {
		return (await this.handler('auth')).authorizeSend(key);
	}

	async revokeLogin(key: string) {
		return (await this.handler('auth')).revokeLogin(key);
	}

	async issueAccountLogin(account: Account) {
		return (await this.handler('auth')).issueAccountLogin(account);
	}

	async verifyAccountLogin(response: AuthenticationResponseJSON, origin: string, ceremony: Ceremony) {
		const auth = await this.handler('auth');
		return auth.verifyAccountLogin(response, origin, ceremony);
	}

	async consumeCeremony(key: string): Promise<Ceremony | undefined> {
		return (await this.handler('auth')).consumeCeremony(key);
	}

	async registerAccount(account: Account, credential: WebAuthnCredential): Promise<void> {
		return (await this.handler('auth')).registerAccount(account, credential);
	}

	async limitRequest(kind: string) {
		return (await this.handler('rate')).limitRequest(kind);
	}

	async consumePhoto(token: string, id: string, mode: string) {
		return (await this.handler('room')).consumePhoto(token, id, mode);
	}

	async revokePhoto(token: string) {
		return (await this.handler('room')).revokePhoto(token);
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		return new RoomHub(this.ctx, this.env).webSocketMessage(ws, raw);
	}

	async webSocketClose(ws: WebSocket) {
		return new RoomHub(this.ctx, this.env).webSocketClose(ws);
	}

	async webSocketError(ws: WebSocket) {
		return new RoomHub(this.ctx, this.env).webSocketError(ws);
	}

	async alarm() {
		const role = (await this.ctx.storage.get<Role>('hub:role')) ?? 'room';
		await this.handlers()[role].alarm();
	}
}
