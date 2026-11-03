import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { generate, migrationFiles, sqlOnly } from './migrations.ts';

const temporary: string[] = [];
const initial = 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);';

function project() {
	const directory = mkdtempSync(join(tmpdir(), 'pico-drop-migrations-test-'));
	temporary.push(directory);
	mkdirSync(join(directory, 'migrations'));
	writeFileSync(join(directory, 'schema.sql'), initial);
	return directory;
}

afterEach(() => {
	for (const directory of temporary.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('initial generation and a second unchanged generation are reproducible', () => {
	const directory = project();
	expect(generate(directory, 'generate', 'initial')).toContain('0001_initial.sql');
	expect(generate(directory, 'generate')).toContain('match');
	expect(generate(directory, 'check')).toContain('match');
	expect(migrationFiles(join(directory, 'migrations'))).toEqual(['0001_initial.sql']);
});

function addedColumn(directory: string) {
	generate(directory, 'generate', 'initial');
	writeFileSync(
		join(directory, 'schema.sql'),
		initial.replace('name TEXT NOT NULL', 'name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0')
	);
	return generate(directory, 'generate', 'add_disabled');
}

test('a declaration change generates only the delta and preserves existing rows', () => {
	const directory = project();
	expect(addedColumn(directory)).toContain('0002_add_disabled.sql');
	const migration = readFileSync(join(directory, 'migrations/0002_add_disabled.sql'), 'utf8');
	expect(migration).toMatch(/ALTER TABLE "?users"? ADD COLUMN "?disabled"?/i);
	expect(migration).not.toMatch(/\b(?:BEGIN|COMMIT);/);
	assertPreservedRows(migration);
	expect(generate(directory, 'check')).toContain('match');
});

function assertPreservedRows(migration: string) {
	const db = new DatabaseSync(':memory:');
	db.exec(initial + "INSERT INTO users VALUES (1, 'Sender');");
	db.exec(migration);
	expect({ ...db.prepare('SELECT * FROM users').get() }).toEqual({ id: 1, name: 'Sender', disabled: 0 });
	db.close();
}

test('check detects ungenerated schema changes without writing a migration', () => {
	const directory = project();
	generate(directory, 'generate', 'initial');
	writeFileSync(join(directory, 'schema.sql'), initial + 'CREATE INDEX users_name ON users(name);');
	expect(() => generate(directory, 'check')).toThrow('differs');
	expect(migrationFiles(join(directory, 'migrations'))).toHaveLength(1);
});

test('removed objects generate a forward migration', () => {
	const directory = project();
	generate(directory, 'generate', 'initial');
	writeFileSync(join(directory, 'schema.sql'), '');
	generate(directory, 'generate', 'remove_users');
	expect(readFileSync(join(directory, 'migrations/0002_remove_users.sql'), 'utf8')).toMatch(/DROP TABLE "?users"?/i);
	expect(generate(directory, 'check')).toContain('match');
});

test('migration names cannot escape the migration directory', () => {
	const directory = project();
	expect(() => generate(directory, 'generate', '../escape')).toThrow('Migration name');
	expect(readdirSync(join(directory, 'migrations'))).toEqual([]);
});

test('invalid history fails before generating any new migration', () => {
	const directory = project();
	writeFileSync(join(directory, 'migrations/0001_invalid.sql'), 'INVALID SQL;');
	expect(() => generate(directory, 'generate')).toThrow();
	expect(migrationFiles(join(directory, 'migrations'))).toHaveLength(1);
});

test('SQL output normalization preserves literals and removes only transaction wrappers', () => {
	expect(sqlOnly('-- Nothing is modified --\n')).toBe('');
	expect(sqlOnly("-- dry run --\nBEGIN;\nCREATE TABLE a (name TEXT DEFAULT 'COMMIT;');\nCOMMIT;\n")).toBe(
		"CREATE TABLE a (name TEXT DEFAULT 'COMMIT;');"
	);
});

const tables = 'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent INTEGER REFERENCES parent(id));';
const seed = 'INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1);';
const rebuild =
	'PRAGMA defer_foreign_keys = ON; DROP TABLE parent; CREATE TABLE parent (id INTEGER PRIMARY KEY); INSERT INTO parent VALUES (1);';

test('history replays each migration in one transaction, matching D1 foreign key deferral', () => {
	const directory = project();
	writeFileSync(join(directory, 'schema.sql'), tables);
	writeFileSync(join(directory, 'migrations/0001_tables.sql'), tables + seed);
	writeFileSync(join(directory, 'migrations/0002_rebuild.sql'), rebuild);
	expect(generate(directory, 'check')).toContain('match');
});
