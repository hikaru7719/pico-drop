import { afterEach, expect, test, vi } from 'vitest';
import { D1AuthStore } from './d1-store.ts';
import { Database } from './d1.fixture.ts';
import { gateway } from './gateway.ts';
import { loginKey, challengeKey } from '../domain/tokens.ts';
import type { Ceremony } from '../domain/auth.ts';
const databases: Database[] = [];
const account = { id: 'user', name: 'Sender' };
const credential = { id: 'passkey', publicKey: new Uint8Array([0, 128, 255]), counter: 0 };

function database() {
	const db = new Database();
	databases.push(db);
	return db;
}

afterEach(() => {
	vi.useRealTimers();
	for (const db of databases.splice(0)) {
		db.sql.close();
	}
});

test('binary credentials and accounts survive adapter recreation', async () => {
	const db = database();
	await db.store.register(account, credential);
	const store = new D1AuthStore(db.binding);
	expect(await store.credential('passkey')).toEqual({ account: 'user', credential });
	expect(await store.account('user')).toEqual({ ...account, disabled: false });
	expect(await store.credential('missing')).toBeUndefined();
	expect(await store.account('missing')).toBeUndefined();
});

test('duplicate credentials roll back the new account', async () => {
	const { store } = database();
	await store.register(account, credential);
	await expect(store.register({ id: 'other', name: 'Other' }, credential)).rejects.toThrow();
	expect(await store.account('other')).toBeUndefined();
	expect(await store.account('user')).toBeDefined();
});

test('credential transports and disabled accounts retain their types', async () => {
	const { store } = database();
	await store.register({ ...account, disabled: true }, { ...credential, transports: ['internal'] });
	expect(await store.credential('passkey')).toMatchObject({ credential: { transports: ['internal'] } });
	expect(await store.account('user')).toMatchObject({ disabled: true });
});

const ceremony = (): Ceremony => ({ kind: 'login', challenge: 'one-time', expiresAt: Date.now() + 1000 });

test('parallel challenge consumption returns the challenge to exactly one caller', async () => {
	const { store } = database();
	const value = ceremony();
	await store.saveCeremony('challenge', value);
	const results = await Promise.all(Array.from({ length: 10 }, () => store.takeCeremony('challenge')));
	expect(results.filter(Boolean)).toEqual([value]);
});

test('pending registration accounts survive serialization and invalidation', async () => {
	const { store } = database();
	const value = { ...ceremony(), kind: 'register' as const, account };
	await store.saveCeremony('registration', value);
	expect(await store.takeCeremony('registration')).toEqual(value);
	await store.saveCeremony('old', value);
	await store.deleteCeremony('old');
	expect(await store.takeCeremony('old')).toBeUndefined();
});

test('concurrent rate requests respect the exact quota', async () => {
	const { store } = database();
	const allowed = await Promise.all(Array.from({ length: 80 }, () => store.incrementRate('ip', 1000, 20)));
	expect(allowed.filter(Boolean)).toHaveLength(20);
	expect(await store.incrementRate('other-ip', 1000, 20)).toBe(true);
});

test('rate windows retain their deadline and restart at its exact boundary', async () => {
	vi.useFakeTimers();
	const { store } = database();
	await store.incrementRate('ip', 1000, 1);
	vi.advanceTimersByTime(999);
	expect(await store.incrementRate('ip', 1000, 1)).toBe(false);
	vi.advanceTimersByTime(1);
	expect(await store.incrementRate('ip', 1000, 1)).toBe(true);
});

async function seedExpiry(db: Database) {
	await db.store.register(account, credential);
	await db.store.saveLogin('expired', { account: account.id, expiresAt: Date.now() });
	await db.store.saveLogin('live', { account: account.id, expiresAt: Date.now() + 1000 });
	await db.store.saveCeremony('old', { ...ceremony(), expiresAt: Date.now() });
	await db.store.incrementRate('old', 1, 20);
}

test('expired logins are rejected before scheduled cleanup', async () => {
	const db = database();
	await seedExpiry(db);
	expect(await db.store.login('expired')).toBeUndefined();
	expect(await db.store.login('live')).toBeDefined();
});

test('cleanup preserves accounts, credentials and live logins', async () => {
	vi.useFakeTimers();
	const db = database();
	await seedExpiry(db);
	vi.advanceTimersByTime(1);
	await db.store.cleanup();
	assertCleanup(db);
	expect(await db.store.account('user')).toBeDefined();
	expect(await db.store.login('live')).toBeDefined();
});

function assertCleanup(db: Database) {
	expect(db.sql.prepare('SELECT * FROM logins WHERE id = ?').get('expired')).toBeUndefined();
	expect(db.sql.prepare('SELECT * FROM challenges').all()).toEqual([]);
	expect(db.sql.prepare('SELECT * FROM rate_limits').all()).toEqual([]);
}

test('credential counters cannot overwrite a concurrent successful verification', async () => {
	const { store } = database();
	await store.register(account, credential);
	await store.updateCredential({ account: account.id, credential: { ...credential, counter: 2 } }, 0);
	const stale = { account: account.id, credential: { ...credential, counter: 1 } };
	await expect(store.updateCredential(stale, 0)).rejects.toThrow('changed');
	expect(await store.credential('passkey')).toMatchObject({ credential: { counter: 2 } });
});

test('login upserts update expiry and deletion is idempotent', async () => {
	const { store } = database();
	await store.register(account, credential);
	await store.saveLogin('login', { account: account.id, expiresAt: 0 });
	await store.saveLogin('login', { account: account.id, expiresAt: Date.now() + 1000 });
	expect(await store.login('login')).toBeDefined();
	await store.deleteLogin('login');
	await store.deleteLogin('login');
	expect(await store.login('login')).toBeUndefined();
});

test('foreign keys reject orphan logins and cascade account deletion', async () => {
	const db = database();
	await expect(db.store.saveLogin('orphan', { account: 'missing', expiresAt: 1000 })).rejects.toThrow();
	await db.store.register(account, credential);
	await db.store.saveLogin('login', { account: account.id, expiresAt: Date.now() + 1000 });
	db.sql.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
	expect(await db.store.credential('passkey')).toBeUndefined();
	expect(await db.store.login('login')).toBeUndefined();
});

function authRequest(path: string, cookie = '') {
	return new Request('http://localhost/api/auth/' + path, { method: 'POST', headers: { Cookie: cookie } });
}

async function authenticatedGateway(db: Database) {
	const token = 'a'.repeat(64);
	await db.store.register(account, credential);
	await db.store.saveLogin(await loginKey(token), { account: account.id, expiresAt: Date.now() + 1000 });
	return { api: gateway(db.env()), cookie: 'pico_auth=' + token };
}

test('gateway authentication and logout use D1 without accessing a Durable Object', async () => {
	const db = database();
	const { api, cookie } = await authenticatedGateway(db);
	expect(await (await api.auth(authRequest('status', cookie))).json()).toEqual({ account: { name: 'Sender' } });
	await api.auth(authRequest('logout', cookie));
	expect(await (await api.auth(authRequest('status', cookie))).json()).toEqual({ account: null });
});

test('D1 auth options invalidate previous challenges', async () => {
	const db = database();
	const api = gateway(db.env());
	const first = await api.auth(authRequest('login/options'));
	const cookie = first.headers.get('Set-Cookie')!.split(';')[0];
	await api.auth(authRequest('login/options', cookie));
	expect(await db.store.takeCeremony(await challengeKey(cookie.split('=')[1]))).toBeUndefined();
});

test('D1 auth API limits attempts to thirty per ten minutes', async () => {
	const db = database();
	const api = gateway(db.env());
	for (let i = 0; i < 30; i++) {
		expect((await api.auth(authRequest('login/options'))).status).toBe(200);
	}
	expect((await api.auth(authRequest('login/options'))).status).toBe(429);
	expect(db.namespace.get).not.toHaveBeenCalled();
});

test('session IP quotas span rooms and reset independently for different IPs', async () => {
	const db = database();
	const api = gateway(db.env());
	const allowed = await Promise.all(Array.from({ length: 25 }, () => api.rate('192.0.2.1', 'session')));
	expect(allowed.filter(Boolean)).toHaveLength(20);
	expect(await api.rate('192.0.2.2', 'session')).toBe(true);
	const rows = db.sql.prepare('SELECT id FROM rate_limits').all();
	expect(rows.every((row) => !String(row.id).includes('192.0.2.'))).toBe(true);
});
