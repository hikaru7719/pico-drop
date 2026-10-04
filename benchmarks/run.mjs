import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { platform, arch, cpus } from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const runs = Number(process.env.BENCH_RUNS ?? 20);
assert(
	Number.isInteger(runs) && runs >= 5,
	'BENCH_RUNS must be an integer >= 5'
);
const targets = [
	{ name: 'sveltekit', port: 4311, command: ['node', 'build/index.js'] },
	{
		name: 'react-router',
		port: 4312,
		command: ['pnpm', 'exec', 'react-router-serve', 'build/server/index.js']
	}
];
const servers = [];
let browser;
const samples = [];
const profiles = [
	{ name: 'local', cpu: 1, latency: 0, throughput: -1 },
	{ name: 'constrained', cpu: 4, latency: 40, throughput: 200_000 }
];

async function start(target) {
	const child = spawn(target.command[0], target.command.slice(1), {
		cwd: new URL(`./${target.name}/`, import.meta.url),
		env: {
			...process.env,
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(target.port)
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	servers.push(child);
	let log = '';
	child.stdout.on('data', (chunk) => {
		log += chunk;
	});
	child.stderr.on('data', (chunk) => {
		log += chunk;
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		assert(child.exitCode === null, log);
		try {
			const response = await fetch(`http://127.0.0.1:${target.port}`);
			if (response.ok) {
				return;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Server did not start: ${log}`);
}

// Programmatic click -> DOM mutation -> next animation frame. This is not INP.
async function interaction(page, button, selector, expected) {
	return page.evaluate(
		({ button, selector, expected }) =>
			new Promise((resolve, reject) => {
				const start = performance.now();
				const timeout = setTimeout(() => {
					observer.disconnect();
					reject(new Error('Interaction timeout'));
				}, 10_000);
				const observer = new MutationObserver(() => {
					const element = document.querySelector(selector);
					const actual =
						selector === 'ul'
							? element.children.length
							: Number(element.textContent);
					if (actual !== expected) {
						return;
					}
					observer.disconnect();
					requestAnimationFrame(() => {
						clearTimeout(timeout);
						resolve(performance.now() - start);
					});
				});
				observer.observe(document.querySelector('main'), {
					childList: true,
					subtree: true,
					characterData: true
				});
				document.querySelectorAll('button')[button].click();
			}),
		{ button, selector, expected }
	);
}

async function measure(target, profile, iteration) {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		reducedMotion: 'reduce'
	});
	try {
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send('Network.enable');
		await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: profile.latency,
			downloadThroughput: profile.throughput,
			uploadThroughput: profile.throughput
		});
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const scripts = new Map();
		const pending = [];
		page.on('response', (response) => {
			if (response.request().resourceType() === 'script') {
				pending.push(
					response.body().then((body) => {
						scripts.set(response.url(), body);
					})
				);
			}
		});
		await page.addInitScript(() => {
			window.benchmark = { ready: 0, lcp: 0 };
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					window.benchmark.lcp = entry.startTime;
				}
			}).observe({ type: 'largest-contentful-paint', buffered: true });
			const observer = new MutationObserver(() => {
				if (document.querySelector('main[data-ready="true"]')) {
					window.benchmark.ready = performance.now();
					observer.disconnect();
				}
			});
			observer.observe(document, {
				subtree: true,
				attributes: true,
				childList: true
			});
		});
		const response = await page.goto(`http://127.0.0.1:${target.port}/`, {
			waitUntil: 'networkidle'
		});
		assert(response.ok());
		assert(
			(await response.text()).includes('写真を選択'),
			'SSR markup missing'
		);
		await page.waitForSelector('main[data-ready="true"]');
		await Promise.all(pending);
		const initial = await page.evaluate(() => ({
			readyMs: window.benchmark.ready,
			fcpMs:
				performance.getEntriesByName('first-contentful-paint')[0]?.startTime ??
				null,
			lcpMs: window.benchmark.lcp,
			ttfbMs: performance.getEntriesByType('navigation')[0].responseStart,
			timeOrigin: performance.timeOrigin
		}));
		assert(initial.readyMs > 0 && initial.fcpMs !== null && initial.lcpMs > 0);
		const jsBytes = [...scripts.values()].reduce(
			(sum, body) => sum + body.length,
			0
		);
		const jsGzipBytes = [...scripts.values()].reduce(
			(sum, body) => sum + gzipSync(body).length,
			0
		);
		const jsEncodedBytes = await page.evaluate(
			(urls) =>
				performance
					.getEntriesByType('resource')
					.filter((entry) => urls.includes(entry.name))
					.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
			[...scripts.keys()]
		);
		const selectMs = await interaction(page, 0, 'ul', 10);
		const progressMs = [];
		for (let value = 1; value <= 20; value++) {
			progressMs.push(await interaction(page, 1, 'output', value));
		}
		assert.equal(await page.locator('progress').getAttribute('value'), '20');
		const navigationMs = await page.evaluate(
			() =>
				new Promise((resolve, reject) => {
					const start = performance.now();
					const timeout = setTimeout(() => {
						observer.disconnect();
						reject(new Error('Navigation timeout'));
					}, 10_000);
					const observer = new MutationObserver(() => {
						if (
							location.pathname !== '/details' ||
							document.querySelector('h1')?.textContent !== '共有の説明'
						) {
							return;
						}
						observer.disconnect();
						requestAnimationFrame(() => {
							clearTimeout(timeout);
							resolve(performance.now() - start);
						});
					});
					observer.observe(document.body, {
						childList: true,
						subtree: true,
						characterData: true
					});
					document.querySelector('a').click();
				})
		);
		assert.equal(
			await page.evaluate(() => performance.timeOrigin),
			initial.timeOrigin,
			'Navigation reloaded document'
		);
		assert.deepEqual(errors, []);
		delete initial.timeOrigin;
		return {
			framework: target.name,
			profile: profile.name,
			iteration,
			...initial,
			jsBytes,
			jsGzipBytes,
			jsEncodedBytes,
			selectMs,
			progressMs,
			navigationMs
		};
	} finally {
		await context.close();
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
	for (const target of targets) {
		await start(target);
	}
	browser = await chromium.launch({ headless: true });
	for (const profile of profiles) {
		// Warm each server, then alternate order to reduce time/order bias. Contexts stay cold.
		for (const target of targets) {
			await measure(target, profile, -1);
		}
		for (let iteration = 0; iteration < runs; iteration++) {
			for (const target of iteration % 2 ? targets.toReversed() : targets) {
				samples.push(await measure(target, profile, iteration));
			}
			console.log(`${profile.name}: ${iteration + 1}/${runs}`);
		}
	}
	const summary = profiles.flatMap((profile) =>
		targets.map((target) => {
			const subset = samples.filter(
				(sample) =>
					sample.framework === target.name && sample.profile === profile.name
			);
			const metrics = Object.fromEntries(
				[
					'readyMs',
					'fcpMs',
					'lcpMs',
					'ttfbMs',
					'jsBytes',
					'jsGzipBytes',
					'jsEncodedBytes',
					'selectMs',
					'navigationMs'
				].map((key) => [key, stats(subset.map((sample) => sample[key]))])
			);
			metrics.progressMs = stats(subset.flatMap((sample) => sample.progressMs));
			return { framework: target.name, profile: profile.name, metrics };
		})
	);
	const result = {
		environment: {
			node: process.version,
			browser: browser.version(),
			platform: platform(),
			arch: arch(),
			cpu: cpus()[0].model,
			runs,
			profiles,
			date: new Date().toISOString()
		},
		summary,
		samples
	};
	await mkdir(new URL('./results/', import.meta.url), { recursive: true });
	await writeFile(
		new URL('./results/latest.json', import.meta.url),
		JSON.stringify(result, null, 2) + '\n'
	);
	console.log(JSON.stringify(summary, null, 2));
} finally {
	await browser?.close();
	for (const child of servers) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {}
	}
}
