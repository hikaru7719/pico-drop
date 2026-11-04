/* eslint-disable max-lines-per-function -- Keep benchmark setup and measurement steps together. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir, cpus, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { build } = await import(require.resolve('vite'));
const baseline = process.env.TRANSFER_BASE_REF ?? 'HEAD';
const runs = Number(process.env.BENCH_RUNS ?? 7);
assert(Number.isInteger(runs) && runs >= 3);
const temporary = await mkdtemp(join(tmpdir(), 'pico-drop-transfer-'));
const sources = [
	'frontend/src/lib/webrtc/connection.ts',
	'frontend/src/lib/webrtc/peer.ts',
	'frontend/src/lib/webrtc/transfer.ts',
	'frontend/src/lib/photos/index.ts',
	'shared/protocol.ts'
];
const bundles = {};
const profiles = [
	{ name: 'local', cpu: 1 },
	{ name: 'cpu4', cpu: 4 }
].filter((profile) => !process.env.TRANSFER_PROFILE || process.env.TRANSFER_PROFILE === profile.name);
const cases = [
	{ files: 1, bytes: 5 * 1024 * 1024 },
	{ files: 10, bytes: 5 * 1024 * 1024 }
].filter((payload) => !process.env.TRANSFER_FILES || Number(process.env.TRANSFER_FILES) === payload.files);
assert(profiles.length && cases.length, 'Unknown TRANSFER_PROFILE or TRANSFER_FILES');
const samples = [];
let browser;
let server;

async function bundle(name, revision) {
	const directory = join(temporary, name);
	for (const path of sources) {
		await mkdir(join(directory, path, '..'), { recursive: true });
		const content = revision
			? execFileSync('git', ['show', `${revision}:${path}`], { cwd: root })
			: await readFile(join(root, path));
		await writeFile(join(directory, path), content);
	}
	const result = await build({
		configFile: false,
		logLevel: 'error',
		build: {
			write: false,
			minify: false,
			lib: { entry: join(directory, sources[0]), formats: ['es'] }
		}
	});
	bundles[`/${name}.js`] = (Array.isArray(result) ? result[0] : result).output[0].code;
}

async function serve() {
	const harness = await readFile(new URL('./browser.mjs', import.meta.url), 'utf8');
	server = createServer((request, response) => {
		const path = request.url;
		response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
		response.end(path === '/harness.js' ? harness : (bundles[path] ?? '<!doctype html><title>WebRTC transfer benchmark</title>'));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${server.address().port}`;
}

async function measure(origin, { variant, profile, payload, iteration }) {
	const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
	try {
		const pages = await Promise.all(contexts.map((context) => context.newPage()));
		for (const page of pages) {
			page.on('pageerror', (error) => console.error(error));
			const cdp = await page.context().newCDPSession(page);
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
			await page.goto(origin);
			await page.addScriptTag({ type: 'module', url: `${origin}/harness.js` });
			await page.waitForFunction(() => typeof window.setup === 'function');
		}
		await Promise.all(
			pages.map((page, index) => page.evaluate((args) => window.setup(args), { variant, ...payload, sender: index === 0 }))
		);
		const offer = await pages[0].evaluate(() => window.offer());
		const answer = await pages[1].evaluate((offer) => window.answer(offer), offer);
		await pages[0].evaluate((answer) => window.pc.setRemoteDescription(answer), answer);
		const [sender, receiver] = await Promise.all(
			pages.map((page) =>
				page.evaluate(() =>
					Promise.race([
						window.result,
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error(`Transfer timeout: ${window.pc.connectionState}`)), 60_000)
						)
					])
				)
			)
		);
		assert.equal(sender.bytes, payload.files * payload.bytes);
		assert.equal(receiver.bytes, sender.bytes);
		assert.equal(receiver.photos, payload.files);
		assert.equal(receiver.valid, true);
		return { variant, profile: profile.name, ...payload, iteration, sender, receiver };
	} finally {
		await Promise.all(contexts.map((context) => context.close()));
	}
}

function stats(values) {
	const sorted = values.toSorted((a, b) => a - b);
	return {
		median: sorted[Math.floor(sorted.length / 2)],
		p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
		min: sorted[0],
		max: sorted.at(-1)
	};
}

try {
	await bundle('baseline', baseline);
	await bundle('current');
	const origin = await serve();
	browser = await chromium.launch({ headless: true });
	for (const profile of profiles) {
		for (const payload of cases) {
			for (const variant of ['baseline', 'current']) {
				await measure(origin, { variant, profile, payload, iteration: -1 });
			}
			for (let iteration = 0; iteration < runs; iteration++) {
				for (const variant of iteration % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
					samples.push(await measure(origin, { variant, profile, payload, iteration }));
				}
				console.log(
					`${profile.name} ${payload.files} files: ${iteration + 1}/${runs}`,
					samples
						.slice(-2)
						.map((s) => `${s.variant}=${s.sender.transferMs.toFixed(1)}ms`)
						.join(' ')
				);
			}
		}
	}
	const summary = profiles.flatMap((profile) =>
		cases.flatMap((payload) =>
			['baseline', 'current'].map((variant) => {
				const subset = samples.filter((s) => s.variant === variant && s.profile === profile.name && s.files === payload.files);
				return {
					variant,
					profile: profile.name,
					files: payload.files,
					transferMs: stats(subset.map((s) => s.sender.transferMs)),
					readMs: stats(subset.map((s) => s.sender.readMs)),
					hashMs: stats(subset.map((s) => s.sender.hashMs)),
					drainMs: stats(subset.map((s) => s.sender.drainMs)),
					progressCalls: stats(subset.map((s) => s.sender.progressCalls))
				};
			})
		)
	);
	const codeHashes = Object.fromEntries(
		Object.entries(bundles).map(([path, code]) => [path, createHash('sha256').update(code).digest('hex')])
	);
	const result = {
		environment: {
			baseline: execFileSync('git', ['rev-parse', baseline], { cwd: root, encoding: 'utf8' }).trim(),
			codeHashes,
			date: new Date().toISOString(),
			node: process.version,
			browser: browser.version(),
			cpu: cpus()[0].model,
			platform: platform(),
			runs,
			profiles,
			cases
		},
		summary,
		samples
	};
	const output = process.env.TRANSFER_RESULT ?? 'benchmarks/results/transfer.json';
	await writeFile(join(root, output), JSON.stringify(result, null, 2) + '\n');
	console.log(JSON.stringify(summary, null, 2));
} finally {
	await browser?.close();
	await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
	await rm(temporary, { recursive: true, force: true });
}
