import { PasskeyAuth } from '../api/auth.ts';
import { AuthService } from '../application/auth.ts';
import { secretHash } from '../domain/tokens.ts';
import type { Bindings } from './bindings.ts';
import { D1AuthStore } from './d1-store.ts';
import { passkeys } from './passkeys.ts';

export function authentication(env: Bindings) {
	return new AuthService(new D1AuthStore(env.DB), passkeys);
}

export function authenticationApi(env: Bindings) {
	return new PasskeyAuth(authentication(env), env);
}

export async function requestRate(env: Bindings, ip: string, kind: string) {
	return new D1AuthStore(env.DB).incrementRate('ip:' + kind + ':' + (await secretHash(ip)), 60_000, 20);
}
