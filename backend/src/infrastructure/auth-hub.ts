import { PasskeyAuth } from '../api/auth.ts';
import { passkeys } from './passkeys.ts';
import { authShard } from '../domain/tokens.ts';
import type { WebAuthnCredential, AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Account, Ceremony } from '../domain/auth.ts';
import { network } from './hub-network.ts';
import type { Bindings } from './bindings.ts';
import { expireRecords, scheduleExpiry } from '../application/expiry.ts';
export class AuthHub {
	constructor(
		private ctx: DurableObjectState,
		private env: Bindings
	) {}

	async accountIdentity(key: string) {
		return this.auth().service.identity(key);
	}

	async authorizeSend(key: string) {
		return this.ctx.blockConcurrencyWhile(() => this.auth().service.allowSend(key));
	}

	async revokeLogin(key: string) {
		if (key) {
			await this.ctx.storage.delete(key);
		}
	}

	async issueAccountLogin(account: Account) {
		const shard = authShard(account.id);
		const auth = this.auth(shard ? 'auth:' + shard : 'mvp');
		const token = auth.service.newToken();
		await auth.service.storeLogin(token, account.id);
		await scheduleExpiry(this.ctx.storage);
		return token;
	}

	async verifyAccountLogin(response: AuthenticationResponseJSON, origin: string, ceremony: Ceremony) {
		return this.ctx.blockConcurrencyWhile(() => this.auth().service.completeLogin(response, new URL(origin), ceremony));
	}

	async authRequest(request: Request) {
		const response = await this.auth(request.headers.get('X-Auth-Route') ?? 'mvp').route(request);
		await scheduleExpiry(this.ctx.storage);
		return response;
	}

	auth(name = 'mvp'): PasskeyAuth {
		const local = {
			take: (key: string) => this.consumeCeremony(key),
			register: (account: Account, credential: WebAuthnCredential) => this.registerAccount(account, credential)
		};
		const remote = this.env?.HUB ? network(this.env, name, local) : undefined;
		return new PasskeyAuth(this.ctx.storage, this.env, remote, passkeys);
	}

	async consumeCeremony(key: string): Promise<Ceremony | undefined> {
		return this.ctx.blockConcurrencyWhile(() => this.auth().service.takeStoredCeremony(key));
	}

	async registerAccount(account: Account, credential: WebAuthnCredential): Promise<void> {
		return this.ctx.blockConcurrencyWhile(() => this.auth().service.storeAccount(account, credential));
	}

	async alarm() {
		await expireRecords(this.ctx.storage);
	}
}
