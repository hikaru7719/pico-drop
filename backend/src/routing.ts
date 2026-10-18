import { randomSecret, readCookie, secretHash } from './auth.ts';
import type { AuthEnv, AuthNetwork, Ceremony } from './auth.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

type Environment = Env & AuthEnv;
export const authShard = (value: string) =>
	/^v2\.([a-f0-9]{2})\./.exec(value)?.[1];
export const authName = (value: string) => {
	const shard = authShard(value);
	return shard ? 'auth:' + shard : 'mvp';
};
export function hubFor(env: Environment, name: string) {
	return env.HUB.get(env.HUB.idFromName(name));
}
export function accountRoute(response: AuthenticationResponseJSON) {
	const handle = response.response.userHandle ?? '';
	return authName(atob(handle.replaceAll('-', '+').replaceAll('_', '/')));
}
export function authRoute(request: Request) {
	const action = new URL(request.url).pathname.split('/').at(-1);
	if (action === 'options') {
		return 'auth:' + randomSecret().slice(0, 2);
	}
	const kind = action === 'verify' ? 'challenge' : 'auth';
	const token = readCookie(request, kind);
	return token ? authName(token) : 'auth:' + randomSecret().slice(0, 2);
}
export function loginRoute(key: string) {
	return authName(key.slice('auth:login:'.length));
}
export function network(
	env: Environment,
	name: string,
	local: Pick<AuthNetwork, 'take' | 'register'>
): AuthNetwork {
	const shard = name.startsWith('auth:') ? name.slice(5) : undefined;
	return { ...local, ...remoteNetwork(env), shard };
}
type RemoteNetwork = Omit<AuthNetwork, 'take' | 'register'>;
function remoteNetwork(env: Environment): RemoteNetwork {
	return {
		login: (response, origin, ceremony) =>
			remoteLogin(env, response, origin, ceremony),
		revoke: (key) => revokeLogin(env, key),
		issue: (account) =>
			hubFor(env, authName(account.id)).issueAccountLogin(account)
	};
}
async function revokeLogin(env: Environment, key: string) {
	if (key) {
		await hubFor(env, loginRoute(key)).revokeLogin(key);
	}
}

async function remoteLogin(
	env: Environment,
	response: AuthenticationResponseJSON,
	origin: string,
	ceremony: Ceremony
) {
	const target = hubFor(env, accountRoute(response));
	return target.verifyAccountLogin(response, origin, ceremony);
}
export async function identity(env: Environment, key: string) {
	return key ? hubFor(env, loginRoute(key)).accountIdentity(key) : undefined;
}
export async function allowSend(env: Environment, key: string) {
	if (!key) {
		throw new Error('写真を送るにはパスキーでログインしてください。');
	}
	return hubFor(env, loginRoute(key)).authorizeSend(key);
}
export async function requestRate(
	env: Environment,
	request: Request,
	kind: string
) {
	const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
	return hubFor(env, 'rate:' + (await secretHash(ip))).limitRequest(kind);
}
export function roomRoute(request: Request) {
	const url = new URL(request.url);
	if (url.pathname === '/api/session') {
		return url.searchParams.get('room') ?? randomSecret().slice(0, 16);
	}
	if (url.pathname === '/api/ws') {
		return url.searchParams.get('room') ?? '';
	}
	return bearerRoom(request);
}
function bearerRoom(request: Request) {
	const token =
		request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
	return /^[a-f0-9]{64}$/.test(token) ? token.slice(0, 16) : '';
}
export function routedToken(room: string | undefined) {
	return room ? room + randomSecret().slice(16) : randomSecret();
}

export async function clearPreviousChallenge(
	env: Environment,
	request: Request
) {
	const token = readCookie(request, 'challenge');
	if (token && new URL(request.url).pathname.endsWith('/options')) {
		const key = 'auth:challenge:' + (await secretHash(token));
		await hubFor(env, authName(token)).consumeCeremony(key);
	}
}
