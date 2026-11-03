import type { AuthStore } from './auth.ts';
import type { Account, Ceremony, Credential, Login } from '../domain/auth.ts';
import type { WebAuthnCredential } from '@simplewebauthn/server';

export function memoryAuthStore(entries: Map<string, any>): AuthStore {
	return new MemoryAuthStore(entries);
}

class MemoryAuthStore implements AuthStore {
	constructor(private entries: Map<string, any>) {}

	private get<T>(key: string): T | undefined {
		return structuredClone(this.entries.get(key));
	}

	async account(id: string) {
		return this.get<Account>('auth:account:' + id);
	}

	async credential(id: string) {
		return this.get<Credential>('auth:credential:' + id);
	}

	async login(key: string) {
		return this.get<Login>(key);
	}

	async saveLogin(key: string, value: Login) {
		this.entries.set(key, structuredClone(value));
	}

	async deleteLogin(key: string) {
		this.entries.delete(key);
	}

	async saveCeremony(key: string, value: Ceremony) {
		this.entries.set(key, structuredClone(value));
	}

	async deleteCeremony(key: string) {
		this.entries.delete(key);
	}

	async takeCeremony(key: string) {
		const value = this.get<Ceremony>(key);
		this.entries.delete(key);
		return value;
	}

	async register(account: Account, credential: WebAuthnCredential) {
		const key = 'auth:credential:' + credential.id;
		if (this.entries.has(key)) {
			throw new Error('Duplicate');
		}
		this.entries.set('auth:account:' + account.id, structuredClone(account));
		this.entries.set(key, structuredClone({ account: account.id, credential }));
	}

	async updateCredential(stored: Credential) {
		this.entries.set('auth:credential:' + stored.credential.id, structuredClone(stored));
	}

	async incrementRate(key: string, duration: number, limit: number) {
		const old = this.entries.get(key);
		const rate = old && old.expiresAt > Date.now() ? old : { count: 0, expiresAt: Date.now() + duration };
		if (rate.count >= limit) {
			return false;
		}
		this.entries.set(key, { ...rate, count: rate.count + 1 });
		return true;
	}
}
