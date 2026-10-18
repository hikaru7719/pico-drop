import {
	generateRegistrationOptions,
	generateAuthenticationOptions,
	verifyRegistrationResponse,
	verifyAuthenticationResponse,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON,
	type WebAuthnCredential
} from '@simplewebauthn/server';

type Reg = RegistrationResponseJSON;
type Auth = AuthenticationResponseJSON;
type AuthCheck = { ceremony: Ceremony; stored: Credential };

export type AuthEnv = { AUTH_ORIGIN?: string };
type Store = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
export type Account = { id: string; name: string; disabled?: boolean };
type Credential = { account: string; credential: WebAuthnCredential };
type Login = { account: string; expiresAt: number };
export type Ceremony = {
	kind: 'register' | 'login';
	challenge: string;
	account?: Account;
	expiresAt: number;
};
const LOGIN_MS = 7 * 24 * 60 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
export const authJson = (data: unknown, status = 200) =>
	Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export const randomSecret = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
		n.toString(16).padStart(2, '0')
	).join('');

export async function secretHash(value: string) {
	const bytes = new TextEncoder().encode(value);
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return Array.from(hash, (n) => n.toString(16).padStart(2, '0')).join('');
}

function cookieName(request: Request, kind: string) {
	const secure = new URL(request.url).protocol === 'https:';
	return `${secure ? '__Host-' : ''}pico_${kind}`;
}

export function readCookie(request: Request, kind: string) {
	const prefix = cookieName(request, kind) + '=';
	return (
		(request.headers.get('Cookie') ?? '')
			.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith(prefix))
			?.slice(prefix.length) ?? ''
	);
}

function setCookie(request: Request, kind: string, value: string, age: number) {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${cookieName(request, kind)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}

export function authOrigin(request: Request, env: AuthEnv) {
	const url = new URL(request.url);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	const origin = env.AUTH_ORIGIN ?? (local ? url.origin : '');
	if (!origin || new URL(origin).origin !== origin || url.origin !== origin) {
		throw new Error('認証の公開URLが設定されていません。');
	}
	requireSecureOrigin(url, local);
	return new URL(origin);
}

const REGISTRATION = {
	rpName: 'Pico Drop',
	attestationType: 'none',
	supportedAlgorithmIDs: [-7, -257],
	authenticatorSelection: {
		residentKey: 'required',
		userVerification: 'required'
	}
} as const;
function registrationOptions(origin: URL, account: Account) {
	return generateRegistrationOptions({
		...REGISTRATION,
		supportedAlgorithmIDs: [...REGISTRATION.supportedAlgorithmIDs],
		rpID: origin.hostname,
		userID: new Uint8Array(new TextEncoder().encode(account.id)),
		userName: `${account.name} (${account.id.slice(0, 8)})`,
		userDisplayName: account.name
	});
}

function verification(origin: URL, ceremony: Ceremony) {
	return {
		expectedOrigin: origin.origin,
		expectedRPID: origin.hostname,
		expectedChallenge: ceremony.challenge,
		requireUserVerification: true
	};
}

function displayName(body: unknown) {
	const name = (body as { name?: unknown })?.name;
	if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) {
		throw new Error('表示名を1〜40文字で入力してください。');
	}
	return name.trim().replace(/[\p{Cc}\p{Cf}]/gu, '');
}

async function bodyJson(request: Request) {
	if (!request.body) {
		throw new Error('Body');
	}
	return new Response(limitedBody(request.body)).json() as Promise<unknown>;
}

function limitedBody(body: ReadableStream<Uint8Array>) {
	return body.pipeThrough(bodyLimit(), { signal: AbortSignal.timeout(5000) });
}

function bodyLimit() {
	let size = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			size += chunk.byteLength;
			checkBodySize(size);
			controller.enqueue(chunk);
		}
	});
}

const AUTH_ERROR =
	'認証できませんでした。表示名やパスキーを確認して再試行してください。';
const RATE_ERROR = '認証の試行が多すぎます。しばらく待ってください。';
const SEND_ERROR =
	'1日あたりの送信上限に達しました。時間をおいてお試しください。';
const failedAuth = () => authJson({ error: AUTH_ERROR }, 400);
const rateError = () => authJson({ error: RATE_ERROR }, 429);
const credentialKey = (id: string) => 'auth:credential:' + id;
const challengeKey = async (token: string) =>
	'auth:challenge:' + (await secretHash(token));
const loginKey = async (token: string) =>
	'auth:login:' +
	(/^v2\.[a-f0-9]{2}\./.exec(token)?.[0] ?? '') +
	(await secretHash(token));
type Rate = { count: number; expiresAt: number };
function currentRate(old: Rate | undefined, duration: number): Rate {
	return old && old.expiresAt > Date.now()
		? old
		: { count: 0, expiresAt: Date.now() + duration };
}

function ceremony(
	kind: Ceremony['kind'],
	challenge: string,
	account?: Account
): Ceremony {
	return { kind, challenge, account, expiresAt: Date.now() + CHALLENGE_MS };
}

function checkCeremony(value: Ceremony | undefined, kind: Ceremony['kind']) {
	if (!value || value.kind !== kind || value.expiresAt <= Date.now()) {
		throw new Error('Challenge');
	}
	return value;
}

function cookieResponse(
	r: Request,
	data: unknown,
	kind: string,
	token: string
) {
	const age = (kind === 'auth' ? LOGIN_MS : CHALLENGE_MS) / 1000;
	return withCookie(authJson(data), setCookie(r, kind, token, age));
}

function withCookie(response: Response, cookie: string) {
	response.headers.append('Set-Cookie', cookie);
	return response;
}

function loginResponse(request: Request, account: Account, token: string) {
	const response = cookieResponse(
		request,
		{ account: { name: account.name } },
		'auth',
		token
	);
	response.headers.append('Set-Cookie', setCookie(request, 'challenge', '', 0));
	return response;
}

function checkAccount(
	account: Account | undefined,
	response: AuthenticationResponseJSON
) {
	if (!account || account.disabled || !validHandle(response, account.id)) {
		throw new Error('Account');
	}
	return account;
}

export type AuthNetwork = {
	shard?: string;
	take(key: string): Promise<Ceremony | undefined>;
	register(account: Account, credential: WebAuthnCredential): Promise<void>;
	login(response: Auth, origin: string, ceremony: Ceremony): Promise<Account>;
	revoke(key: string): Promise<void>;
	issue(account: Account): Promise<string>;
};

export class PasskeyAuth {
	constructor(
		private storage: Store,
		private env: AuthEnv,
		private network?: AuthNetwork
	) {}

	async loginKey(request: Request) {
		const token = readCookie(request, 'auth');
		return /^(?:v2\.[a-f0-9]{2}\.)?[a-f0-9]{64}$/.test(token)
			? await loginKey(token)
			: '';
	}

	async identity(key: string) {
		const login = key ? await this.storage.get<Login>(key) : undefined;
		if (!login || login.expiresAt <= Date.now()) {
			return undefined;
		}
		const account = await this.storage.get<Account>(
			'auth:account:' + login.account
		);
		return account && !account.disabled ? account : undefined;
	}

	async route(request: Request) {
		if (request.method !== 'POST') {
			return authJson({ error: 'Method not allowed' }, 405);
		}
		try {
			return await this.post(request);
		} catch {
			return failedAuth();
		}
	}

	async post(request: Request) {
		const action = this.action(request);
		if (action === 'status') {
			return this.status(request);
		}
		if (action === 'logout') {
			return this.logout(request);
		}
		return this.authAction(request, action);
	}

	action(request: Request) {
		authOrigin(request, this.env);
		return new URL(request.url).pathname.slice('/api/auth/'.length);
	}

	async authAction(request: Request, action: string) {
		const origin = authOrigin(request, this.env);
		return this.network || (await this.rate(request))
			? this.ceremonyRoute(request, origin, action)
			: rateError();
	}

	ceremonyRoute(request: Request, origin: URL, action: string) {
		const routes: Record<string, () => Promise<Response>> = {
			'register/options': () => this.registerOptions(request, origin),
			'login/options': () => this.loginOptions(request, origin),
			'register/verify': () => this.registerVerify(request, origin),
			'login/verify': () => this.loginVerify(request, origin)
		};
		return callRoute(routes, action);
	}

	async rate(request: Request) {
		const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
		return this.incrementRate('auth:rate:' + (await secretHash(ip)), 600_000);
	}

	async incrementRate(key: string, duration: number) {
		const rate = currentRate(await this.storage.get<Rate>(key), duration);
		if (++rate.count > 30) {
			return false;
		}
		await this.storage.put(key, rate);
		return true;
	}

	async status(request: Request) {
		const account = await this.identity(await this.loginKey(request));
		return authJson({ account: account ? { name: account.name } : null });
	}

	async logout(request: Request) {
		const key = await this.loginKey(request);
		if (key) {
			await this.storage.delete(key);
		}
		const response = authJson({ account: null });
		response.headers.append('Set-Cookie', setCookie(request, 'auth', '', 0));
		return response;
	}

	async registerOptions(request: Request, origin: URL) {
		const account = await newAccount(request);
		if (this.network?.shard) {
			account.id = `v2.${this.network.shard}.${account.id}`;
		}
		const options = await registrationOptions(origin, account);
		const value = ceremony('register', options.challenge, account);
		return this.saveCeremony(request, options, value);
	}

	async loginOptions(request: Request, origin: URL) {
		const options = await generateAuthenticationOptions({
			rpID: origin.hostname,
			userVerification: 'required'
		});
		const value = ceremony('login', options.challenge);
		return this.saveCeremony(request, options, value);
	}

	async saveCeremony(request: Request, options: unknown, value: Ceremony) {
		await this.storage.delete(
			await challengeKey(readCookie(request, 'challenge'))
		);
		const token = this.newToken();
		await this.storage.put(await challengeKey(token), value);
		return cookieResponse(request, options, 'challenge', token);
	}

	async takeCeremony(request: Request, kind: Ceremony['kind']) {
		const key = await challengeKey(readCookie(request, 'challenge'));
		const value = this.network
			? await this.network.take(key)
			: await this.takeStoredCeremony(key);
		return checkCeremony(value, kind);
	}

	async takeStoredCeremony(key: string) {
		const value = await this.storage.get<Ceremony>(key);
		await this.storage.delete(key);
		return value;
	}

	async registerVerify(request: Request, origin: URL) {
		const value = await this.takeCeremony(request, 'register');
		const response = (await bodyJson(request)) as RegistrationResponseJSON;
		const credential = await verifySignup(response, origin, value);
		await (this.network
			? this.network.register(value.account!, credential)
			: this.storeAccount(value.account!, credential));
		return this.issueLogin(request, value.account!);
	}

	async storeAccount(account: Account, credential: WebAuthnCredential) {
		const key = credentialKey(credential.id);
		if (await this.storage.get(key)) {
			throw new Error('Duplicate');
		}
		await this.storage.put('auth:account:' + account.id, account);
		const stored: Credential = { account: account.id, credential };
		await this.storage.put(key, stored);
	}

	async loginVerify(request: Request, origin: URL) {
		const ceremony = await this.takeCeremony(request, 'login');
		const response = (await bodyJson(request)) as Auth;
		const account = this.network
			? await this.network.login(response, origin.origin, ceremony)
			: await this.completeLogin(response, origin, ceremony);
		return this.issueLogin(request, account);
	}

	async completeLogin(response: Auth, origin: URL, ceremony: Ceremony) {
		const stored = await this.loadCredential(response.id);
		return this.verifyLogin(response, origin, { ceremony, stored });
	}

	newToken() {
		const prefix = this.network?.shard ? `v2.${this.network.shard}.` : '';
		return prefix + randomSecret();
	}

	async loadCredential(id: string) {
		const stored = await this.storage.get<Credential>(credentialKey(id));
		if (!stored) {
			throw new Error('Credential');
		}
		return stored;
	}

	async verifyLogin(response: Auth, origin: URL, data: AuthCheck) {
		const result = await verifyAssertion(response, origin, data);
		const account = await this.checkedAccount(data.stored.account, response);
		data.stored.credential.counter = result.authenticationInfo.newCounter;
		await this.storage.put(
			credentialKey(data.stored.credential.id),
			data.stored
		);
		return account;
	}

	async checkedAccount(id: string, response: Auth) {
		return checkAccount(
			await this.storage.get<Account>('auth:account:' + id),
			response
		);
	}

	async issueLogin(request: Request, account: Account) {
		const key = await this.loginKey(request);
		if (this.network) {
			await this.network.revoke(key);
			return loginResponse(request, account, await this.network.issue(account));
		}
		return this.issueLocalLogin(request, account, key);
	}

	async issueLocalLogin(request: Request, account: Account, key: string) {
		await this.storage.delete(key);
		const token = this.newToken();
		await this.storeLogin(token, account.id);
		return loginResponse(request, account, token);
	}

	async storeLogin(token: string, account: string) {
		await this.storage.put(await loginKey(token), {
			account,
			expiresAt: Date.now() + LOGIN_MS
		} satisfies Login);
	}

	async allowSend(key: string) {
		const account = await this.identity(key);
		if (!account) {
			throw new Error('写真を送るにはパスキーでログインしてください。');
		}
		if (!(await this.incrementRate('auth:send:' + account.id, 86_400_000))) {
			throw new Error(SEND_ERROR);
		}
		return account;
	}
}

function validHandle(response: AuthenticationResponseJSON, id: string) {
	const encoded = btoa(id)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
	return response.response.userHandle === encoded;
}

async function verifySignup(response: Reg, rp: URL, step: Ceremony) {
	const options = {
		...verification(rp, step),
		supportedAlgorithmIDs: [-7, -257]
	};
	const result = await verifyRegistrationResponse({ response, ...options });
	verified(result.verified && !!step.account);
	return result.registrationInfo!.credential;
}

async function verifyAssertion(response: Auth, origin: URL, data: AuthCheck) {
	const options = {
		credential: data.stored.credential,
		...verification(origin, data.ceremony)
	};
	const result = await verifyAuthenticationResponse({ response, ...options });
	verified(result.verified);
	return result;
}

function verified(value: boolean) {
	if (!value) {
		throw new Error('Verification');
	}
}

async function newAccount(request: Request) {
	const name = displayName(await bodyJson(request));
	if (!name) {
		throw new Error('Name');
	}
	return { id: crypto.randomUUID(), name };
}

function callRoute(
	routes: Record<string, () => Promise<Response>>,
	action: string
) {
	return Object.hasOwn(routes, action)
		? routes[action]()
		: authJson({ error: 'Not found' }, 404);
}

function checkBodySize(size: number) {
	if (size > 24_000) {
		throw new Error('Body too large');
	}
}

function requireSecureOrigin(url: URL, local: boolean) {
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		throw new Error('HTTPS required');
	}
}
