// Run against `mise run dev`. Playwright may be supplied by the local tool runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { chromium } = await import(
	process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH
		? { executablePath: process.env.CHROME_PATH }
		: {})
});
const baseURL = process.env.TEST_URL || 'http://localhost:5173';
const contexts = [];
const errors = [];
function countPeers() {
	window.peerCount = 0;
	const Original = window.RTCPeerConnection;
	window.RTCPeerConnection = class extends Original {
		constructor(...args) {
			super(...args);
			window.peerCount++;
		}
	};
}
async function deviceContext() {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		geolocation: { latitude: 35.6812, longitude: 139.7671, accuracy: 20 },
		permissions: ['geolocation']
	});
	contexts.push(context);
	await context.addInitScript(countPeers);
	return context;
}
async function startDiscovery(page) {
	const button = page.getByRole('button', {
		name: '近くの人を探す',
		exact: true
	});
	await button.waitFor();
	assert.equal(await page.locator('input[type=file]').count(), 0);
	await button.click();
}
async function openDevice(context) {
	const page = await context.newPage();
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(baseURL);
	await page.waitForLoadState('networkidle');
	await startDiscovery(page);
	return page;
}

async function device() {
	return openDevice(await deviceContext());
}
async function reconnect(a, b) {
	await a.getByRole('button', { name: '近くの人を探す', exact: true }).click();
	await b.getByRole('button', { name: '近くの人を探す', exact: true }).click();
	await a
		.getByRole('button', { name: /を選ぶ$/ })
		.first()
		.click();
}
try {
	const a = await device();
	await a
		.getByRole('status')
		.filter({ hasText: '近くの人を探しています' })
		.waitFor();
	await a.addScriptTag({
		path: new URL('./fixtures/browser-helpers.js', import.meta.url).pathname
	});
	await a.waitForFunction(() => window.discoveryCentered());
	assert.equal(
		await a.getByRole('heading', { name: 'Photos, Right Nearby.' }).count(),
		0
	);
	assert.equal(
		await a.getByRole('button', { name: 'もう一度探す', exact: true }).count(),
		0
	);
	assert.equal(
		await a
			.getByRole('button', { name: '近くの人を探す', exact: true })
			.count(),
		0
	);
	await a.screenshot({ path: '/tmp/pico-drop-discovery.png', fullPage: true });
	await a.emulateMedia({ reducedMotion: 'reduce' });
	assert.equal(
		await a
			.locator('.ripple')
			.first()
			.evaluate((el) => getComputedStyle(el).animationName),
		'none'
	);
	await a.emulateMedia({ reducedMotion: 'no-preference' });
	await a.getByRole('button', { name: '探索を停止する', exact: true }).click();
	// Restart must make this device discoverable without waiting for the next refresh.
	await a.getByRole('button', { name: '近くの人を探す', exact: true }).click();
	const b = await device();
	await a
		.getByRole('button', { name: /を選ぶ$/ })
		.first()
		.click({ timeout: 5000 });
	await a
		.getByRole('heading', { name: '写真を選んで送る', exact: true })
		.waitFor();
	assert.equal(await b.locator('input[type=file]').count(), 0);
	assert.equal(
		await a.getByRole('button', { name: '送る', exact: true }).isEnabled(),
		false
	);
	await a.getByRole('button', { name: '相手を選び直す', exact: true }).click();
	assert.equal(await a.locator('input[type=file]').count(), 0);
	await a
		.getByRole('button', { name: /を選ぶ$/ })
		.first()
		.click();
	const jpeg = await a.evaluate(() => window.testJpeg());
	const photo = Buffer.from(jpeg, 'base64');
	await a.locator('input[type=file]').setInputFiles([
		{ name: 'trip.jpg', mimeType: 'image/jpeg', buffer: photo },
		{ name: 'friends.jpg', mimeType: 'image/jpeg', buffer: photo }
	]);
	await a
		.getByRole('button', { name: 'trip.jpgを選択から外す', exact: true })
		.click();
	assert.deepEqual(await a.locator('.file-list li > span').allTextContents(), [
		'friends.jpg'
	]);
	await a
		.getByRole('button', { name: 'friends.jpgを選択から外す', exact: true })
		.click();
	assert.equal(await a.locator('.file-list li').count(), 0);
	assert.equal(
		await a.getByRole('button', { name: '送る', exact: true }).isEnabled(),
		false
	);
	await a.locator('input[type=file]').setInputFiles([
		{ name: 'trip.jpg', mimeType: 'image/jpeg', buffer: photo },
		{ name: 'friends.jpg', mimeType: 'image/jpeg', buffer: photo }
	]);
	await a.getByRole('button', { name: '送る', exact: true }).click();
	await b.getByRole('button', { name: '辞退する', exact: true }).click();
	await a.getByRole('alert').filter({ hasText: '辞退' }).waitFor();
	assert.equal(await a.evaluate(() => window.peerCount), 0);
	// Receiver acceptance starts the transfer directly; no peer exists before approval.
	await reconnect(a, b);
	await a.getByRole('button', { name: '送る', exact: true }).click();
	await b.getByRole('button', { name: '受け取る', exact: true }).waitFor();
	assert.equal(await a.evaluate(() => window.peerCount), 0);
	assert.equal(await b.evaluate(() => window.peerCount), 0);
	await b.getByRole('button', { name: '受け取る', exact: true }).click();
	await b
		.getByRole('heading', { name: '2枚の写真を受け取りました', exact: true })
		.waitFor({ timeout: 60_000 });
	await a.getByRole('status').filter({ hasText: 'データ一致' }).waitFor();
	const received = await b.locator('.gallery a').evaluateAll(async (links) =>
		Promise.all(
			links.map(async (link) => {
				const bytes = await (await fetch(link.href)).arrayBuffer();
				return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
					.map((v) => v.toString(16).padStart(2, '0'))
					.join('');
			})
		)
	);
	assert.deepEqual(received, [
		createHash('sha256').update(photo).digest('hex'),
		createHash('sha256').update(photo).digest('hex')
	]);
	assert.equal(
		await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		true
	);
	await b.screenshot({
		path: process.env.SCREENSHOT_PATH || '/tmp/pico-drop-received.png',
		fullPage: true
	});
	await b.evaluate(() => {
		Object.defineProperty(navigator, 'canShare', {
			configurable: true,
			value: () => false
		});
	});
	await b
		.getByRole('button', { name: '写真に保存・共有', exact: true })
		.click();
	await b
		.getByRole('status')
		.filter({ hasText: '共有に対応していません' })
		.waitFor();
	assert.equal(await b.locator('.gallery a').count(), 2);
	await b.getByRole('button', { name: '写真を破棄する', exact: true }).click();
	assert.equal(await b.locator('.gallery a').count(), 0);
	// Peer disconnect while awaiting approval must release the sender's transfer.
	await reconnect(a, b);
	await a.getByRole('button', { name: '送る', exact: true }).click();
	await b.getByRole('button', { name: '受け取る', exact: true }).waitFor();
	await b.close();
	await a.getByRole('alert').filter({ hasText: '接続が切れました' }).waitFor();
	assert.deepEqual(errors, []);
	console.log(
		'PASS: two-browser discovery, reject, direct transfer after receiver acceptance, multi-photo WebRTC, SHA-256 match, mobile layout, share fallback, unsaved-photo retention, discard, disconnect'
	);
} finally {
	for (const context of contexts) {
		await context.close();
	}
	await browser.close();
}
