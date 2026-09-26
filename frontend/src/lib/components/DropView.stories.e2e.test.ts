import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, URL } from 'node:url';

const run = promisify(execFile);
test('storybook browser scenario', async () => {
	const file = fileURLToPath(
		new URL('./DropView.stories.scenario.mjs', import.meta.url)
	);
	await run(process.execPath, [file], { timeout: 115_000 });
}, 120_000);
