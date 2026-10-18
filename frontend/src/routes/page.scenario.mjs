import { virtualPasskey } from '../../../shared/passkey-fixture.mjs';
// Run against `mise run dev` without location permission in either browser.
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
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
async function device() {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 }
	});
	contexts.push(context);
	await context.addInitScript(countPeers);
	return openPage(context);
}
async function openPage(context) {
	const page = await context.newPage();
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(baseURL);
	await page.waitForLoadState('networkidle');
	return page;
}
async function createLink(page) {
	await page.getByRole('button', { name: '写真を渡す', exact: true }).click();
	const link = await readQr(page);
	assert.equal(await verifyQrLayout(page), link);
	await page.screenshot({ path: '/tmp/pico-drop-qr.png', fullPage: true });
	return link;
}
async function readQr(page) {
	const image = page.getByRole('img', { name: '写真を受け取るためのQRコード' });
	await image.waitFor();
	const { data, width, height } = await image.evaluate(qrPixels);
	const decoded = jsQR(new Uint8ClampedArray(data), width, height);
	assert.ok(decoded, 'QR must be readable');
	return decoded.data;
}
function qrPixels(image) {
	const canvas = document.createElement('canvas');
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const { width, height } = canvas;
	const context = canvas.getContext('2d');
	context.drawImage(image, 0, 0);
	const data = Array.from(context.getImageData(0, 0, width, height).data);
	return { data, width, height };
}

async function verifyQrLayout(page) {
	await page.getByText('リンクで送る', { exact: true }).click();
	const field = page.getByRole('textbox', { name: '共有リンク', exact: true });
	const url = await field.inputValue();
	assert.match(url, /#share=[a-f0-9]{64}$/);
	await page.getByText('リンクで送る', { exact: true }).click();
	assert.equal(await field.isVisible(), false);
	return url;
}

async function join(page, link) {
	await page.goto(link);
	const count = await peerCount(page);
	await page.getByRole('button', { name: '受け取る', exact: true }).waitFor();
	assert.equal(await peerCount(page), count);
}
async function peerCount(page) {
	return page.evaluate(() => window.peerCount);
}

async function noPeers(a, b) {
	assert.equal(await a.evaluate(() => window.peerCount), 0);
	assert.equal(await b.evaluate(() => window.peerCount), 0);
}
async function clickButton(page, name) {
	await page.getByRole('button', { name, exact: true }).click();
}

async function revoked(a, b) {
	const link = await createLink(a);
	await a.getByRole('button', { name: '共有を取り消す', exact: true }).click();
	await b.goto(link);
	await b.getByRole('alert').filter({ hasText: '有効期限が切れた' }).waitFor();
}
async function rejected(a, b) {
	await join(b, await createLink(a));
	await noPeers(a, b);
	await b.getByRole('button', { name: '受け取らない', exact: true }).click();
	await a
		.getByRole('alert')
		.filter({ hasText: '受け取りませんでした' })
		.waitFor();
	await noPeers(a, b);
}
async function receive(a, b) {
	const link = await createLink(a);
	await join(b, link);
	await noPeers(a, b);
	await b.getByRole('button', { name: '受け取る', exact: true }).click();
	await transferComplete(a, b);
	return link;
}
async function transferComplete(a, b) {
	await b
		.getByRole('heading', { name: '2枚の写真を受け取りました', exact: true })
		.waitFor({ timeout: 60_000 });
	await a.getByRole('status').filter({ hasText: '同じデータ' }).waitFor();
}
async function browserHashes(links) {
	async function hash(link) {
		const bytes = await (await fetch(link.href)).arrayBuffer();
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		const hex = Array.from(digest, (v) => v.toString(16).padStart(2, '0'));
		return hex.join('');
	}
	return Promise.all(links.map(hash));
}
async function verifyPhotos(b, photo) {
	const hashes = await b.locator('.gallery a').evaluateAll(browserHashes);
	const expected = createHash('sha256').update(photo).digest('hex');
	assert.deepEqual(hashes, Array(2).fill(expected));
	await verifyLayout(b);
}
async function verifyLayout(b) {
	assert.equal(
		await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		true
	);
	await b.screenshot({
		path: process.env.SCREENSHOT_PATH || '/tmp/pico-drop-received.png',
		fullPage: true
	});
}
async function reuse(link) {
	const c = await device();
	await c.goto(link);
	await c.getByRole('alert').filter({ hasText: 'すでに使われた' }).waitFor();
}
function unsupportedShare() {
	Object.defineProperty(navigator, 'canShare', {
		configurable: true,
		value: () => false
	});
}
async function saveAndDiscard(b) {
	await b.evaluate(unsupportedShare);
	await b
		.getByRole('button', { name: '写真を保存・共有する', exact: true })
		.click();
	await shareFallback(b);
	await clickButton(b, '画面内の写真を削除する');
	assert.equal(await b.locator('.gallery a').count(), 0);
}
async function shareFallback(b) {
	await b
		.getByRole('status')
		.filter({ hasText: 'このブラウザでは写真を共有できません' })
		.waitFor();
	assert.equal(await b.locator('.gallery a').count(), 2);
}
async function disconnect(a, b) {
	await join(b, await createLink(a));
	await b.close();
	await a.getByRole('alert').filter({ hasText: '接続が切れました' }).waitFor();
}
async function selectPhotos(a) {
	await a.addScriptTag({
		path: new URL('./page.browser-fixture.js', import.meta.url).pathname
	});
	const photo = await readPhoto(a);
	await a.locator('input[type=file]').setInputFiles(photoFiles(photo));
	return photo;
}
async function readPhoto(a) {
	return Buffer.from(await a.evaluate(() => window.testJpeg()), 'base64');
}

function photoFiles(photo) {
	return ['trip.jpg', 'friends.jpg'].map((name) => ({
		name,
		mimeType: 'image/jpeg',
		buffer: photo
	}));
}
async function scenario() {
	const a = await device(),
		b = await device();
	const photo = await prepareSender(a);
	await revoked(a, b);
	await rejected(a, b);
	await reuse(await receive(a, b));
	await verifyPhotos(b, photo);
	await finish(a, b);
}
async function finish(a, b) {
	await saveAndDiscard(b);
	await disconnect(a, b);
	assert.deepEqual(errors, []);
}
try {
	await scenario();
	console.log(
		'PASS: passkey registration/logout/login, anonymous send disabled, short-lived links, revoke, reject, single use, no RTC before approval, multi-photo RTC, SHA-256 match, mobile layout, save fallback, discard, disconnect without location permission'
	);
} finally {
	for (const context of contexts) {
		await context.close();
	}
	await browser.close();
}

async function verifyPasskeyLogin(page) {
	await virtualPasskey(page);
	await page.getByLabel('初めての方は表示名を入力').fill('Test Sender');
	await clickButton(page, 'パスキーを作成してはじめる');
	await loggedIn(page);
	await clickButton(page, 'ログアウト');
	await clickButton(page, 'パスキーでログイン');
	await loggedIn(page);
}

async function loggedIn(page) {
	await page
		.getByRole('status')
		.filter({ hasText: 'Test Sender としてログイン中' })
		.waitFor();
}

async function prepareSender(page) {
	const photo = await selectPhotos(page);
	const send = page.getByRole('button', { name: '写真を渡す', exact: true });
	assert.equal(await send.isDisabled(), true);
	await verifyPasskeyLogin(page);
	await page.screenshot({ path: '/tmp/pico-drop-auth.png', fullPage: true });
	return photo;
}
