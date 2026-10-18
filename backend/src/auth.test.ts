import { test, expect } from 'vitest';
import { PasskeyAuth, authOrigin, secretHash } from './auth.ts';

type Storage = ConstructorParameters<typeof PasskeyAuth>[0];
class Fixture {
	entries = new Map<string, any>();
	auth = new PasskeyAuth(this.store(), {
		AUTH_ORIGIN: 'https://photos.example'
	});
	store(): Storage {
		return {
			get: async (key: string) => structuredClone(this.entries.get(key)),
			put: async (key: string, value: unknown) => {
				this.entries.set(key, structuredClone(value));
			},
			delete: async (key: string) => this.entries.delete(key)
		} as Storage;
	}
	request(path: string, body?: unknown, cookie = '') {
		return new Request('https://photos.example/api/auth/' + path, {
			method: 'POST',
			headers: { Origin: 'https://photos.example', Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	}
	async begin(kind = 'register') {
		return this.auth.route(this.request(kind + '/options', { name: 'Guest' }));
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
	expect(await app.auth.identity(key)).toMatchObject({ name: 'Guest' });
	await app.auth.route(app.request('logout', undefined, cookie));
	expect(await app.auth.identity(key)).toBeUndefined();
});

test('send quota survives new browser sessions for the same account', async () => {
	const app = new Fixture();
	const { key } = await app.identity();
	for (let i = 0; i < 30; i++) {
		await app.auth.allowSend(key);
	}
	await expect(app.auth.allowSend(key)).rejects.toThrow('送信上限');
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
