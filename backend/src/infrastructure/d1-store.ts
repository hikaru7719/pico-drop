import type { AuthStore } from '../application/auth.ts';
import type { Account, Ceremony, Credential, Login } from '../domain/auth.ts';
import type { WebAuthnCredential } from '@simplewebauthn/server';

type AccountRow = { id: string; name: string; disabled: number };
type CredentialRow = { id: string; account_id: string; public_key: number[]; counter: number; transports: string | null };
type CeremonyRow = {
	kind: Ceremony['kind'];
	challenge: string;
	account_id: string | null;
	account_name: string | null;
	expires_at: number;
};
const RATE_UPSERT = `INSERT INTO rate_limits (id, count, expires_at) VALUES (?, 1, ?)
ON CONFLICT(id) DO UPDATE SET
    count = CASE WHEN rate_limits.expires_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
    expires_at = CASE WHEN rate_limits.expires_at <= ? THEN excluded.expires_at ELSE rate_limits.expires_at END
WHERE rate_limits.expires_at <= ? OR rate_limits.count < ? RETURNING count`;

export class D1AuthStore implements AuthStore {
	constructor(private db: D1Database) {}

	async account(id: string): Promise<Account | undefined> {
		const row = await this.db.prepare('SELECT id, name, disabled FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
		return row ? { ...row, disabled: Boolean(row.disabled) } : undefined;
	}

	async login(key: string): Promise<Login | undefined> {
		const query = 'SELECT account_id AS account, expires_at AS expiresAt FROM logins WHERE id = ? AND expires_at > ?';
		return (await this.db.prepare(query).bind(key, Date.now()).first<Login>()) ?? undefined;
	}

	async credential(id: string): Promise<Credential | undefined> {
		const row = await this.db.prepare('SELECT * FROM credentials WHERE id = ?').bind(id).first<CredentialRow>();
		return row ? decodeCredential(row) : undefined;
	}

	async saveLogin(key: string, value: Login) {
		const query = `INSERT INTO logins (id, account_id, expires_at) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, expires_at = excluded.expires_at`;
		await this.db.prepare(query).bind(key, value.account, value.expiresAt).run();
	}

	async deleteLogin(key: string) {
		await this.db.prepare('DELETE FROM logins WHERE id = ?').bind(key).run();
	}

	async saveCeremony(key: string, value: Ceremony) {
		const query = 'INSERT INTO challenges (id, kind, challenge, account_id, account_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)';
		await this.db
			.prepare(query)
			.bind(key, value.kind, value.challenge, value.account?.id ?? null, value.account?.name ?? null, value.expiresAt)
			.run();
	}

	async deleteCeremony(key: string) {
		await this.db.prepare('DELETE FROM challenges WHERE id = ?').bind(key).run();
	}

	async takeCeremony(key: string): Promise<Ceremony | undefined> {
		const row = await this.db.prepare('DELETE FROM challenges WHERE id = ? RETURNING *').bind(key).first<CeremonyRow>();
		return row ? decodeCeremony(row) : undefined;
	}

	async register(account: Account, credential: WebAuthnCredential) {
		await this.db.batch([
			this.db
				.prepare('INSERT INTO accounts (id, name, disabled) VALUES (?, ?, ?)')
				.bind(account.id, account.name, Number(!!account.disabled)),
			this.insertCredential(account.id, credential)
		]);
	}

	private insertCredential(account: string, credential: WebAuthnCredential) {
		const query = 'INSERT INTO credentials (id, account_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)';
		return this.db
			.prepare(query)
			.bind(credential.id, account, credential.publicKey, credential.counter, JSON.stringify(credential.transports) ?? null);
	}

	async updateCredential(stored: Credential, previousCounter: number) {
		const query = 'UPDATE credentials SET counter = ? WHERE id = ? AND counter = ?';
		const result = await this.db.prepare(query).bind(stored.credential.counter, stored.credential.id, previousCounter).run();
		if (result.meta.changes !== 1) {
			throw new Error('Credential changed during verification');
		}
	}

	async incrementRate(key: string, duration: number, limit: number) {
		const now = Date.now();
		const row = await this.db
			.prepare(RATE_UPSERT)
			.bind(key, now + duration, now, now, now, limit)
			.first();
		return row !== null;
	}

	async cleanup() {
		const now = Date.now();
		await this.db.batch([
			this.db.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM logins WHERE expires_at <= ?').bind(now),
			this.db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now)
		]);
	}
}

function decodeCredential(row: CredentialRow): Credential {
	const credential = {
		id: row.id,
		publicKey: Uint8Array.from(row.public_key),
		counter: row.counter,
		transports: row.transports === null ? undefined : JSON.parse(row.transports)
	};
	return { account: row.account_id, credential };
}

function decodeCeremony(row: CeremonyRow): Ceremony {
	const account = row.account_id === null ? undefined : { id: row.account_id, name: row.account_name! };
	return { kind: row.kind, challenge: row.challenge, account, expiresAt: row.expires_at };
}
