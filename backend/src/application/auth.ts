import type { Account, Credential, Login, Ceremony } from '../domain/auth.ts';
import {
	randomSecret,
	secretHash,
	loginKey,
	challengeKey,
	sessionLoginKey
} from '../domain/tokens.ts';
import { ServiceError } from './errors.ts';
import type {
	generateRegistrationOptions,
	generateAuthenticationOptions,
	verifyRegistrationResponse,
	verifyAuthenticationResponse,
	RegistrationResponseJSON,
	AuthenticationResponseJSON,
	WebAuthnCredential
} from '@simplewebauthn/server';

type Reg = RegistrationResponseJSON;
type Auth = AuthenticationResponseJSON;
type AuthCheck = { ceremony: Ceremony; stored: Credential };
export interface PasskeyVerifier {
	generateRegistrationOptions: typeof generateRegistrationOptions;
	generateAuthenticationOptions: typeof generateAuthenticationOptions;
	verifyRegistrationResponse: typeof verifyRegistrationResponse;
	verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}
export type AuthEnv = { AUTH_ORIGIN?: string };
export interface AuthStore {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
}
const LOGIN_MS = 7 * 24 * 60 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const REGISTRATION = {
	rpName: 'Pico Drop',
	attestationType: 'none',
	supportedAlgorithmIDs: [-7, -257],
	authenticatorSelection: {
		residentKey: 'required',
		userVerification: 'required'
	}
} as const;
type Passkeys = PasskeyVerifier;
function registrationOptions(api: Passkeys, origin: URL, account: Account) {
	return api.generateRegistrationOptions({
		...REGISTRATION,
		supportedAlgorithmIDs: [...REGISTRATION.supportedAlgorithmIDs],
		rpID: origin.hostname,
		...registrationUser(account)
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

const RATE_ERROR = '認証の試行が多すぎます。しばらく待ってください。';
const SEND_ERROR =
	'1日あたりの送信上限に達しました。時間をおいてお試しください。';
const credentialKey = (id: string) => 'auth:credential:' + id;
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

function cookieResult(
	data: unknown,
	kind: 'auth' | 'challenge',
	token: string
): AuthResult {
	return { data, cookie: { kind, token } };
}
function loginResult(account: Account, token: string): AuthResult {
	return {
		...cookieResult({ account: { name: account.name } }, 'auth', token),
		clearChallenge: true
	};
}
export type AuthInput = {
	origin: URL;
	auth: string;
	challenge: string;
	ip: string;
	body(): Promise<unknown>;
};
export type AuthResult = {
	data: unknown;
	cookie?: { kind: 'auth' | 'challenge'; token: string };
	clearChallenge?: boolean;
};
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

export class AuthService {
	private verification: PasskeyVerification;
	constructor(
		protected storage: AuthStore,
		protected network: AuthNetwork | undefined,
		private verifier: PasskeyVerifier
	) {
		this.verification = new PasskeyVerification(verifier);
	}

	async loginKey(input: AuthInput) {
		return sessionLoginKey(input.auth);
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

	async authorizeAction(input: AuthInput) {
		if (!this.network && !(await this.rate(input))) {
			throw new ServiceError('rate-limit', RATE_ERROR);
		}
	}

	async rate(request: AuthInput) {
		const ip = request.ip;
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

	async status(request: AuthInput) {
		const account = await this.identity(await this.loginKey(request));
		return { data: { account: account ? { name: account.name } : null } };
	}

	async logout(request: AuthInput) {
		const key = await this.loginKey(request);
		if (key) {
			await this.storage.delete(key);
		}
		return cookieResult({ account: null }, 'auth', '');
	}

	async registerOptions(request: AuthInput, origin: URL) {
		const account = await newAccount(request);
		if (this.network?.shard) {
			account.id = `v2.${this.network.shard}.${account.id}`;
		}
		const options = await registrationOptions(this.verifier, origin, account);
		const value = ceremony('register', options.challenge, account);
		return this.saveCeremony(request, options, value);
	}

	async loginOptions(request: AuthInput, origin: URL) {
		const options = await this.verifier.generateAuthenticationOptions({
			rpID: origin.hostname,
			userVerification: 'required'
		});
		const value = ceremony('login', options.challenge);
		return this.saveCeremony(request, options, value);
	}

	async saveCeremony(request: AuthInput, options: unknown, value: Ceremony) {
		await this.storage.delete(await challengeKey(request.challenge));
		const token = this.newToken();
		await this.storage.put(await challengeKey(token), value);
		return cookieResult(options, 'challenge', token);
	}

	async takeCeremony(request: AuthInput, kind: Ceremony['kind']) {
		const key = await challengeKey(request.challenge);
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

	async registerVerify(request: AuthInput, origin: URL) {
		const value = await this.takeCeremony(request, 'register');
		const response = (await request.body()) as RegistrationResponseJSON;
		const credential = await this.verification.signup(response, origin, value);
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

	async loginVerify(request: AuthInput, origin: URL) {
		const ceremony = await this.takeCeremony(request, 'login');
		const response = (await request.body()) as Auth;
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
		const result = await this.verification.assertion(response, origin, data);
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

	async issueLogin(request: AuthInput, account: Account) {
		const key = await this.loginKey(request);
		if (this.network) {
			await this.network.revoke(key);
			return loginResult(account, await this.network.issue(account));
		}
		return this.issueLocalLogin(request, account, key);
	}

	async issueLocalLogin(request: AuthInput, account: Account, key: string) {
		await this.storage.delete(key);
		const token = this.newToken();
		await this.storeLogin(token, account.id);
		return loginResult(account, token);
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

class PasskeyVerification {
	constructor(private api: PasskeyVerifier) {}
	async signup(response: Reg, rp: URL, step: Ceremony) {
		const options = {
			response,
			...verification(rp, step),
			supportedAlgorithmIDs: [-7, -257]
		};
		const result = await this.api.verifyRegistrationResponse(options);
		verified(result.verified && !!step.account);
		return result.registrationInfo!.credential;
	}
	async assertion(response: Auth, origin: URL, data: AuthCheck) {
		const options = {
			response,
			credential: data.stored.credential,
			...verification(origin, data.ceremony)
		};
		const result = await this.api.verifyAuthenticationResponse(options);
		verified(result.verified);
		return result;
	}
}

function verified(value: boolean) {
	if (!value) {
		throw new Error('Verification');
	}
}

async function newAccount(request: AuthInput) {
	const name = displayName(await request.body());
	if (!name) {
		throw new Error('Name');
	}
	return { id: crypto.randomUUID(), name };
}

function registrationUser(account: Account) {
	return {
		userID: new Uint8Array(new TextEncoder().encode(account.id)),
		userName: `${account.name} (${account.id.slice(0, 8)})`,
		userDisplayName: account.name
	};
}
