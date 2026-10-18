import { test, expect, vi, afterEach } from 'vitest';
import type {
	AuthNetwork,
	AuthStore,
	PasskeyVerifier
} from '../application/auth.ts';
import type { Account } from '../domain/auth.ts';
import type {
	verifyRegistrationResponse,
	verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { PasskeyAuth } from './auth.ts';
import { authOrigin } from './http.ts';
import { secretHash } from '../domain/tokens.ts';
import { passkeys } from '../infrastructure/passkeys.ts';

type Verifier = PasskeyVerifier;
const authEnv = { AUTH_ORIGIN: 'https://photos.example' };
class Fixture {
	entries = new Map<string, any>();
	auth: PasskeyAuth;
	lastChallenge = '';

	constructor(network?: AuthNetwork, verifier?: Verifier) {
		this.auth = new PasskeyAuth(
			this.store(),
			authEnv,
			network,
			verifier ?? passkeys
		);
	}

	store(): AuthStore {
		return {
			get: async (key: string) => structuredClone(this.entries.get(key)),
			put: async (key: string, value: unknown) => {
				this.entries.set(key, structuredClone(value));
			},
			delete: async (key: string) => this.entries.delete(key)
		};
	}

	request(path: string, body?: unknown, cookie = '') {
		return new Request('https://photos.example/api/auth/' + path, {
			method: 'POST',
			headers: { Origin: 'https://photos.example', Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	}

	async begin(kind = 'register') {
		const request = this.request(kind + '/options', { name: 'Guest' });
		const response = await this.auth.route(request);
		this.lastChallenge = ((await response.clone().json()) as any).challenge;
		return response;
	}

	async identity() {
		const token = 'a'.repeat(64);
		const key = 'auth:login:' + (await secretHash(token));
		this.entries.set('auth:account:user', { id: 'user', name: 'Guest' });
		this.entries.set(key, { account: 'user', expiresAt: Date.now() + 1000 });
		return { key, cookie: '__Host-pico_auth=' + token };
	}
}

const cookieOf = (response: Response) =>
	response.headers.get('Set-Cookie')!.split(';')[0];

const challenges = (app: Fixture) =>
	[...app.entries.keys()].filter((key) => key.startsWith('auth:challenge:'));

test('registration requires a discoverable passkey and user verification, with a protected cookie', async () => {
	const response = await new Fixture().begin();
	const options = (await response.json()) as any;
	expect(options.authenticatorSelection).toMatchObject({
		...REQUIRED_PASSKEY
	});
	expect(response.headers.get('Set-Cookie')).toMatch(PROTECTED_COOKIE);
	expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('a challenge cannot be used by another browser', async () => {
	const app = new Fixture();
	await app.begin();
	const response = await app.auth.route(app.request('register/verify', {}));
	expect(response.status).toBe(400);
	expect(challenges(app)).toHaveLength(1);
});

test('failed verification consumes the challenge and never creates an account', async () => {
	const app = new Fixture();
	const cookie = cookieOf(await app.begin());
	const response = await app.auth.route(
		app.request('register/verify', {}, cookie)
	);
	expect(response.status).toBe(400);
	expect(challenges(app)).toHaveLength(0);
	expect(hasAccount(app)).toBe(false);
});

test('expired challenges are rejected', async () => {
	const app = new Fixture();
	const cookie = cookieOf(await app.begin());
	app.entries.get(challenges(app)[0]).expiresAt = Date.now();
	expect(await verifyStatus(app, 'register', cookie)).toBe(400);
});

test('a challenge for the wrong operation is rejected', async () => {
	const app = new Fixture();
	const cookie = cookieOf(await app.begin());
	expect(await verifyStatus(app, 'login', cookie)).toBe(400);
});

test('logout revokes the server session, including copies of the cookie', async () => {
	const app = new Fixture();
	const { key, cookie } = await app.identity();
	expect(await app.auth.service.identity(key)).toMatchObject({ name: 'Guest' });
	await app.auth.route(app.request('logout', undefined, cookie));
	expect(await app.auth.service.identity(key)).toBeUndefined();
});

test('send quota survives new browser sessions for the same account', async () => {
	const app = new Fixture();
	const { key } = await app.identity();
	for (let i = 0; i < 30; i++) {
		await app.auth.service.allowSend(key);
	}
	await expect(app.auth.service.allowSend(key)).rejects.toThrow('送信上限');
});

test('input size limits are enforced', async () => {
	const app = new Fixture();
	const response = await app.auth.route(
		app.request('register/options', { name: 'x'.repeat(25_000) })
	);
	expect(response.status).toBe(400);
});

test('authentication rate limits are enforced', async () => {
	const app = new Fixture();
	for (let i = 0; i < 30; i++) {
		await app.begin('login');
	}
	expect((await app.begin('login')).status).toBe(429);
});

test('production origin must be explicitly configured and must match', () => {
	const request = new Request('https://photos.example/api/auth/status');
	expect(() => authOrigin(request, {})).toThrow();
	expect(() =>
		authOrigin(request, { AUTH_ORIGIN: 'https://attacker.example' })
	).toThrow();
	expect(
		authOrigin(request, { AUTH_ORIGIN: 'https://photos.example' }).hostname
	).toBe('photos.example');
});

const REQUIRED_PASSKEY = {
	residentKey: 'required',
	userVerification: 'required'
};
const PROTECTED_COOKIE =
	/^__Host-pico_challenge=.*HttpOnly; SameSite=Strict; Max-Age=300; Secure$/;

const hasAccount = (app: Fixture) =>
	[...app.entries.keys()].some((key) => key.startsWith('auth:account:'));

async function verifyStatus(app: Fixture, kind: string, cookie: string) {
	return (await app.auth.route(app.request(kind + '/verify', {}, cookie)))
		.status;
}

test('production cannot configure an insecure origin', () => {
	const request = new Request('http://photos.example/api/auth/status');
	expect(() =>
		authOrigin(request, { AUTH_ORIGIN: 'http://photos.example' })
	).toThrow();
});

const credential = {
	id: 'credential',
	publicKey: new Uint8Array([1, 2, 3]),
	counter: 0
};
const authenticationInfo = {
	credentialID: credential.id,
	newCounter: 1,
	userVerified: true,
	credentialDeviceType: 'singleDevice' as const,
	credentialBackedUp: false,
	origin: 'https://photos.example',
	rpID: 'photos.example'
};

function verifier() {
	return {
		...passkeys,
		verifyRegistrationResponse: registrationVerifier(),
		verifyAuthenticationResponse: vi
			.fn<typeof verifyAuthenticationResponse>()
			.mockResolvedValue(loginResult)
	} satisfies PasskeyVerifier;
}

const loginResult = { verified: true, authenticationInfo };
const registrationResult = {
	verified: true as const,
	registrationInfo: {
		fmt: 'none' as const,
		aaguid: 'aaguid',
		credential,
		credentialType: 'public-key' as const,
		attestationObject: new Uint8Array(),
		...authenticationInfo
	}
};

async function register(app: Fixture) {
	const cookie = cookieOf(await app.begin());
	return app.auth.route(
		app.request('register/verify', { id: credential.id }, cookie)
	);
}

function assertionBody(account: string) {
	return {
		id: credential.id,
		response: { userHandle: btoa(account).replace(/=+$/, '') }
	};
}

async function login(app: Fixture, account: string, cookie = '') {
	const challenge = cookieOf(await app.begin('login'));
	const cookies = [challenge, cookie].join('; ');
	return app.auth.route(
		app.request('login/verify', assertionBody(account), cookies)
	);
}

function storedCredential(app: Fixture) {
	return app.entries.get('auth:credential:credential');
}

async function sessionKey(app: Fixture, response: Response) {
	return app.auth.loginKey(
		app.request('status', undefined, cookieOf(response))
	);
}

async function registeredApp() {
	const check = verifier();
	const app = new Fixture(undefined, check);
	const response = await register(app);
	const account = [...app.entries.values()].find(
		(value) => value.name === 'Guest'
	) as Account;
	return { app, check, response, account };
}

function expectVerification(options: unknown, challenge: string) {
	expect(options).toMatchObject({
		expectedOrigin: 'https://photos.example',
		expectedRPID: 'photos.example',
		expectedChallenge: challenge,
		requireUserVerification: true
	});
}

test('registration stores the verified credential and issues a protected login', async () => {
	const { app, response, account, check } = await registeredApp();
	expect(response.status).toBe(200);
	expect(storedCredential(app).account).toBe(account.id);
	expect(await response.json()).toEqual({ account: { name: 'Guest' } });
	expect(response.headers.get('set-cookie')).toContain(
		'Max-Age=604800; Secure'
	);
	assertSignupVerification(check, app.lastChallenge);
});

function assertSignupVerification(
	check: ReturnType<typeof verifier>,
	challenge: string
) {
	const options = check.verifyRegistrationResponse.mock.calls[0][0];
	expect(options.supportedAlgorithmIDs).toEqual([-7, -257]);
	expectVerification(options, challenge);
}

test('successful login rotates the old session and advances the credential counter', async () => {
	const { app, response, account, check } = await registeredApp();
	const oldKey = await sessionKey(app, response);
	const result = await login(app, account.id, cookieOf(response));
	expect(result.status).toBe(200);
	expect(app.entries.has(oldKey)).toBe(false);
	expect(storedCredential(app).credential.counter).toBe(1);
	const options = check.verifyAuthenticationResponse.mock.calls[0][0];
	expectVerification(options, app.lastChallenge);
});
test('unverified assertions cannot create a login or advance the counter', async () => {
	const { app, account, check } = await registeredApp();
	check.verifyAuthenticationResponse.mockResolvedValue({
		verified: false,
		authenticationInfo
	});
	expect((await login(app, account.id)).status).toBe(400);
	expect(storedCredential(app).credential.counter).toBe(0);
});
test('unverified registration never stores an account', async () => {
	const check = verifier();
	check.verifyRegistrationResponse.mockResolvedValue({ verified: false });
	const app = new Fixture(undefined, check);
	expect((await register(app)).status).toBe(400);
	expect(hasAccount(app)).toBe(false);
});
test('a credential cannot be registered twice', async () => {
	const { app } = await registeredApp();
	expect((await register(app)).status).toBe(400);
	expect(
		[...app.entries.keys()].filter((key) => key.startsWith('auth:account:'))
	).toHaveLength(1);
});
test('unknown credentials are rejected before cryptographic verification', async () => {
	const check = verifier();
	const app = new Fixture(undefined, check);
	expect((await login(app, 'missing')).status).toBe(400);
	expect(check.verifyAuthenticationResponse).not.toHaveBeenCalled();
});
test.each(['missing', 'disabled', 'handle'])(
	'login rejects an account that is %s',
	async (reason) => {
		const { app, account } = await registeredApp();
		invalidateAccount(app, account, reason);
		expect(
			(await login(app, reason === 'handle' ? 'other' : account.id)).status
		).toBe(400);
		expect(
			app.entries.get('auth:credential:credential').credential.counter
		).toBe(0);
	}
);

function invalidateAccount(app: Fixture, account: Account, reason: string) {
	if (reason === 'missing') {
		app.entries.delete('auth:account:' + account.id);
	} else if (reason === 'disabled') {
		app.entries.set('auth:account:' + account.id, {
			...account,
			disabled: true
		});
	}
}

test.each([
	undefined,
	null,
	{},
	{ name: 1 },
	{ name: '' },
	{ name: 'x'.repeat(41) },
	{ name: '\u0000' }
])('invalid registration name %j returns a generic error', async (body) => {
	const app = new Fixture();
	expect(
		(await app.auth.route(app.request('register/options', body))).status
	).toBe(400);
	expect(challenges(app)).toHaveLength(0);
});
test('display names are trimmed and control characters removed', async () => {
	const app = new Fixture();
	await app.auth.route(
		app.request('register/options', { name: '  A\u0000B  ' })
	);
	expect(app.entries.get(challenges(app)[0]).account.name).toBe('AB');
});

async function status(app: Fixture, cookie = '') {
	return (
		await app.auth.route(app.request('status', undefined, cookie))
	).json();
}

test('status reports public account data and logout also works without a cookie', async () => {
	const app = new Fixture();
	const { cookie } = await app.identity();
	expect(await status(app, cookie)).toEqual({ account: { name: 'Guest' } });
	expect(await status(app)).toEqual({ account: null });
	expect((await app.auth.route(app.request('logout'))).status).toBe(200);
});
test.each(['expired', 'missing', 'disabled'])(
	'identity rejects %s sessions or accounts',
	async (reason) => {
		const app = new Fixture();
		const { key } = await app.identity();
		invalidateIdentity(app, key, reason);
		expect(await app.auth.service.identity(key)).toBeUndefined();
		await expect(app.auth.service.allowSend(key)).rejects.toThrow('ログイン');
	}
);

function invalidateIdentity(app: Fixture, key: string, reason: string) {
	if (reason === 'expired') {
		app.entries.get(key).expiresAt = Date.now();
	} else {
		invalidateAccount(app, { id: 'user', name: 'Guest' }, reason);
	}
}

test('expired rate windows restart at one request', async () => {
	const app = new Fixture();
	app.entries.set('rate', { count: 30, expiresAt: Date.now() });
	expect(await app.auth.service.incrementRate('rate', 1000)).toBe(true);
	expect(app.entries.get('rate').count).toBe(1);
});
test('only known POST auth routes are accepted', async () => {
	const app = new Fixture();
	const request = new Request('https://photos.example/api/auth/status');
	expect((await app.auth.route(request)).status).toBe(405);
	expect((await app.auth.route(app.request('toString'))).status).toBe(404);
	expect((await app.auth.route(app.request('unknown'))).status).toBe(404);
});
test('local HTTP development uses unprefixed non-secure cookies', async () => {
	const auth = new PasskeyAuth(new Fixture().store(), {}, undefined, passkeys);
	const request = new Request('http://localhost/api/auth/login/options', {
		method: 'POST'
	});
	const response = await auth.route(request);
	expect(response.status).toBe(200);
	expect(response.headers.get('set-cookie')).toMatch(/^pico_challenge=/);
	expect(response.headers.get('set-cookie')).not.toContain('Secure');
});
const remoteAccount = { id: 'v2.ab.user', name: 'Remote' };

function remoteNetwork() {
	return {
		shard: 'ab',
		take: vi.fn(),
		register: vi.fn(),
		revoke: vi.fn(),
		login: vi.fn().mockResolvedValue(remoteAccount),
		issue: vi.fn().mockResolvedValue('v2.ab.' + 'b'.repeat(64))
	};
}

function networkFixture() {
	const network = remoteNetwork();
	return { network, app: new Fixture(network, verifier()) };
}

async function remoteRegister(
	app: Fixture,
	network: ReturnType<typeof remoteNetwork>
) {
	const cookie = cookieOf(await app.begin());
	const ceremony = app.entries.get(challenges(app)[0]);
	network.take.mockResolvedValue(ceremony);
	const request = app.request('register/verify', { id: credential.id }, cookie);
	return { response: await app.auth.route(request), ceremony };
}

test('sharded registration uses network storage and rotates the remote session', async () => {
	const { app, network } = networkFixture();
	const { response, ceremony } = await remoteRegister(app, network);
	expect(response.status).toBe(200);
	expect(ceremony.account.id).toMatch(/^v2\.ab\./);
	expect(network.register).toHaveBeenCalledWith(ceremony.account, credential);
	expect(network.issue).toHaveBeenCalledWith(ceremony.account);
});

const remoteCeremony = () => ({
	kind: 'login',
	challenge: 'challenge',
	expiresAt: Date.now() + 1000
});

test('sharded login verifies on the account shard and revokes the previous login', async () => {
	const { app, network } = networkFixture();
	network.take.mockResolvedValue(remoteCeremony());
	const cookie = '__Host-pico_auth=' + 'a'.repeat(64);
	const response = await login(app, remoteAccount.id, cookie);
	expect(response.status).toBe(200);
	await assertRemoteLogin(network);
});

async function assertRemoteLogin(network: ReturnType<typeof remoteNetwork>) {
	expect(network.login).toHaveBeenCalledWith(
		expect.objectContaining({ id: credential.id }),
		'https://photos.example',
		expect.objectContaining({ challenge: 'challenge' })
	);
	const oldKey = 'auth:login:' + (await secretHash('a'.repeat(64)));
	expect(network.revoke).toHaveBeenCalledWith(oldKey);
	expect(network.issue).toHaveBeenCalledWith(remoteAccount);
}

afterEach(() => vi.restoreAllMocks());

function registrationVerifier() {
	return vi
		.fn<typeof verifyRegistrationResponse>()
		.mockResolvedValue(registrationResult);
}
