import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { vi } from 'vitest';
import { D1AuthStore } from './d1-store.ts';
import type { Bindings } from './bindings.ts';

const directory = fileURLToPath(new URL('../../migrations/', import.meta.url));

export class Database {
	sql = new DatabaseSync(':memory:');
	binding = this as unknown as D1Database;
	store = new D1AuthStore(this.binding);
	namespace = { idFromName: vi.fn(), get: vi.fn() };

	constructor() {
		for (const name of readdirSync(directory)
			.filter((file) => file.endsWith('.sql'))
			.sort()) {
			this.sql.exec(readFileSync(join(directory, name), 'utf8'));
		}
	}

	prepare(sql: string) {
		return new Statement(this.sql, sql);
	}

	async batch(statements: Statement[]) {
		this.sql.exec('BEGIN');
		try {
			await this.executeBatch(statements);
		} catch (error) {
			this.sql.exec('ROLLBACK');
			throw error;
		}
	}

	private async executeBatch(statements: Statement[]) {
		for (const statement of statements) {
			await statement.run();
		}
		this.sql.exec('COMMIT');
	}

	env() {
		return { DB: this.binding, HUB: this.namespace } as unknown as Bindings;
	}
}

class Statement {
	private args: SQLInputValue[] = [];
	private statement;

	constructor(db: DatabaseSync, sql: string) {
		this.statement = db.prepare(sql);
	}

	bind(...values: SQLInputValue[]) {
		this.args = values;
		return this;
	}

	async first() {
		return this.statement.get(...this.args) ?? null;
	}

	async run() {
		return { meta: { changes: Number(this.statement.run(...this.args).changes) } };
	}
}
