import { authName, secretHash } from '../domain/tokens.ts';
import type { AuthNetwork } from '../application/auth.ts';
import type { Ceremony, Account } from '../domain/auth.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export interface AuthHub {
	verifyAccountLogin(
		response: AuthenticationResponseJSON,
		origin: string,
		ceremony: Ceremony
	): Promise<Account>;
	issueAccountLogin(account: Account): Promise<string>;
	revokeLogin(key: string): Promise<void>;
	accountIdentity(key: string): Promise<Account | undefined>;
	authorizeSend(key: string): Promise<Account>;
	limitRequest(kind: string): Promise<boolean>;
	consumeCeremony(key: string): Promise<Ceremony | undefined>;
}
export interface HubNamespace<Id, Hub> {
	idFromName(name: string): Id;
	get(id: Id): Hub;
}
interface Environment<Id> {
	HUB: HubNamespace<Id, AuthHub>;
}
interface AccountAssertion {
	response: { userHandle?: string };
}
export function hubFor<Id, Hub>(
	env: { HUB: HubNamespace<Id, Hub> },
	name: string
) {
	return env.HUB.get(env.HUB.idFromName(name));
}
export function accountRoute(response: AccountAssertion) {
	const handle = response.response.userHandle ?? '';
	return authName(atob(handle.replaceAll('-', '+').replaceAll('_', '/')));
}
export function loginRoute(key: string) {
	return authName(key.slice('auth:login:'.length));
}
export function network<Id>(
	env: Environment<Id>,
	name: string,
	local: Pick<AuthNetwork, 'take' | 'register'>
): AuthNetwork {
	const shard = name.startsWith('auth:') ? name.slice(5) : undefined;
	return { ...local, ...remoteNetwork(env), shard };
}
type RemoteNetwork = Omit<AuthNetwork, 'take' | 'register'>;
function remoteNetwork<Id>(env: Environment<Id>): RemoteNetwork {
	return {
		login: (response, origin, ceremony) =>
			remoteLogin(env, response, origin, ceremony),
		revoke: (key) => revokeLogin(env, key),
		issue: (account) =>
			hubFor(env, authName(account.id)).issueAccountLogin(account)
	};
}
async function revokeLogin<Id>(env: Environment<Id>, key: string) {
	if (key) {
		await hubFor(env, loginRoute(key)).revokeLogin(key);
	}
}

async function remoteLogin<Id>(
	env: Environment<Id>,
	response: AuthenticationResponseJSON,
	origin: string,
	ceremony: Ceremony
) {
	const target = hubFor(env, accountRoute(response));
	return target.verifyAccountLogin(response, origin, ceremony);
}
export async function identity<Id>(env: Environment<Id>, key: string) {
	return key ? hubFor(env, loginRoute(key)).accountIdentity(key) : undefined;
}
export async function allowSend<Id>(env: Environment<Id>, key: string) {
	if (!key) {
		throw new Error('写真を送るにはパスキーでログインしてください。');
	}
	return hubFor(env, loginRoute(key)).authorizeSend(key);
}
export async function requestRate<Id>(
	env: Environment<Id>,
	ip: string,
	kind: string
) {
	return hubFor(env, 'rate:' + (await secretHash(ip))).limitRequest(kind);
}
export async function clearPreviousChallenge<Id>(
	env: Environment<Id>,
	token: string
) {
	const key = 'auth:challenge:' + (await secretHash(token));
	await hubFor(env, authName(token)).consumeCeremony(key);
}
