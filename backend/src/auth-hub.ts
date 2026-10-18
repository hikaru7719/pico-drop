import type {
	WebAuthnCredential,
	AuthenticationResponseJSON
} from '@simplewebauthn/server';
import { PasskeyAuth, type Account, type Ceremony } from './auth.ts';
import { network, authShard } from './routing.ts';
import type { Bindings } from './bindings.ts';
import { expireRecords, scheduleExpiry } from './expiry.ts';
export class AuthHub {
	constructor(
		private ctx: DurableObjectState,
		private env: Bindings
	) {}
	async accountIdentity(key: string) {
		return this.auth().identity(key);
	}
	async authorizeSend(key: string) {
		return this.ctx.blockConcurrencyWhile(() => this.auth().allowSend(key));
	}
	async revokeLogin(key: string) {
		if (key) {
			await this.ctx.storage.delete(key);
		}
	}
	async issueAccountLogin(account: Account) {
		const shard = authShard(account.id);
		const auth = this.auth(shard ? 'auth:' + shard : 'mvp');
		const token = auth.newToken();
		await auth.storeLogin(token, account.id);
		await scheduleExpiry(this.ctx.storage);
		return token;
	}
	async verifyAccountLogin(
		response: AuthenticationResponseJSON,
		origin: string,
		ceremony: Ceremony
	) {
		return this.ctx.blockConcurrencyWhile(() =>
			this.auth().completeLogin(response, new URL(origin), ceremony)
		);
	}
	async authRequest(request: Request) {
		const response = await this.auth(
			request.headers.get('X-Auth-Route') ?? 'mvp'
		).route(request);
		await scheduleExpiry(this.ctx.storage);
		return response;
	}
	auth(name = 'mvp'): PasskeyAuth {
		const local = {
			take: (key: string) => this.consumeCeremony(key),
			register: (account: Account, credential: WebAuthnCredential) =>
				this.registerAccount(account, credential)
		};
		const remote = this.env?.HUB ? network(this.env, name, local) : undefined;
		return new PasskeyAuth(this.ctx.storage, this.env, remote);
	}
	async consumeCeremony(key: string): Promise<Ceremony | undefined> {
		return this.ctx.blockConcurrencyWhile(() =>
			this.auth().takeStoredCeremony(key)
		);
	}
	async registerAccount(
		account: Account,
		credential: WebAuthnCredential
	): Promise<void> {
		return this.ctx.blockConcurrencyWhile(() =>
			this.auth().storeAccount(account, credential)
		);
	}
	async alarm() {
		await expireRecords(this.ctx.storage);
	}
}
