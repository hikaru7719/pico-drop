import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, URL } from 'node:url';

type SchemaRow = { sql: string };
const root = fileURLToPath(new URL('../', import.meta.url));

export function migrationFiles(directory: string) {
	return readdirSync(directory)
		.filter((name) => name.endsWith('.sql'))
		.sort();
}

function replay(project: string) {
	const db = new DatabaseSync(':memory:');
	try {
		applyHistory(db, project);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function applyHistory(db: DatabaseSync, project: string) {
	for (const name of migrationFiles(join(project, 'migrations'))) {
		apply(db, readFileSync(join(project, 'migrations', name), 'utf8'));
	}
}

function apply(db: DatabaseSync, sql: string) {
	db.exec('BEGIN;\n' + sql + '\nCOMMIT;');
}

function schema(db: DatabaseSync) {
	const rows = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
	return (rows as SchemaRow[]).map((row) => row.sql + ';').join('\n');
}

function diff(db: DatabaseSync, project: string, temporary: string) {
	const current = join(temporary, 'current.sql');
	writeFileSync(current, schema(db));
	const args = ['--enable-drop', '--file', join(project, 'schema.sql'), current];
	return sqlOnly(execFileSync('sqlite3def', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
}

export function sqlOnly(output: string) {
	if (output.trim() === '-- Nothing is modified --') {
		return '';
	}
	return output
		.replace(/^-- dry run --\r?\n/, '')
		.replace(/^BEGIN;\r?\n/, '')
		.replace(/\r?\nCOMMIT;\s*$/, '')
		.trim();
}

function validatePlan(db: DatabaseSync, sql: string, project: string, temporary: string) {
	apply(db, sql);
	if (diff(db, project, temporary)) {
		throw new Error('Generated migration does not reproduce schema.sql');
	}
	if (db.prepare('PRAGMA foreign_key_check').all().length) {
		throw new Error('Generated migration violates foreign keys');
	}
}

export function generate(project: string, action: string, name = 'schema') {
	const temporary = mkdtempSync(join(tmpdir(), 'pico-drop-schema-'));
	try {
		return plan(project, action, name, temporary);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function plan(project: string, action: string, name: string, temporary: string) {
	const directory = join(project, 'migrations');
	mkdirSync(directory, { recursive: true });
	const db = replay(project);
	try {
		return finishPlan({ project, action, name, temporary }, db);
	} finally {
		db.close();
	}
}

type Plan = { project: string; action: string; name: string; temporary: string };

function finishPlan(options: Plan, db: DatabaseSync) {
	const { project, action, temporary } = options;
	const sql = diff(db, project, temporary);
	if (action === 'check' && sql) {
		throw new Error('schema.sql differs from migration history. Run mise run //backend:db:generate -- <name>.');
	}
	return sql ? savePlan(options, db, sql) : 'Schema and migration history match.';
}

function savePlan(options: Plan, db: DatabaseSync, sql: string) {
	validatePlan(db, sql, options.project, options.temporary);
	const directory = join(options.project, 'migrations');
	const filename = nextFilename(directory, options.name);
	writeFileSync(join(directory, filename), sql + '\n', { flag: 'wx' });
	return 'Created migrations/' + filename;
}

function nextFilename(directory: string, name: string) {
	if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
		throw new Error('Migration name must use lowercase letters, digits, underscores or hyphens.');
	}
	const number = Math.max(0, ...migrationFiles(directory).map((file) => Number.parseInt(file))) + 1;
	return String(number).padStart(4, '0') + '_' + name + '.sql';
}

function main() {
	const [action, name] = process.argv.slice(2);
	if (action !== 'check' && action !== 'generate') {
		throw new Error('Usage: migrations.ts <generate|check> [name]');
	}
	process.stdout.write(generate(root, action, name) + '\n');
}

if (import.meta.main) {
	main();
}
