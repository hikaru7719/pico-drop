import { virtualPasskey } from '../../../shared/passkey-fixture.mjs';
// Run against `mise run dev` without location permission in either browser.
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { createHash } from 'node:crypto';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
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
	await verifySelectedPhotos(page);
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
	await assertAnonymousReceiver(page);
	assert.equal(await peerCount(page), count);
}

async function assertAnonymousReceiver(page) {
	const login = page.getByRole('region', {
		name: '送信者のログイン',
		exact: true
	});
	assert.equal(await login.count(), 0);
	assert.equal(await page.locator('input[type=file]').count(), 0);
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
	await a.getByRole('alert').filter({ hasText: '受け取りませんでした' }).waitFor();
	await noPeers(a, b);
}

async function receive(a, b) {
	const link = await createLink(a);
	await join(b, link);
	await noPeers(a, b);
	await verifySelectedPhotos(a);
	await b.getByRole('button', { name: '受け取る', exact: true }).click();
	await transferComplete(a, b);
	return link;
}

async function transferComplete(a, b) {
	await b.getByRole('heading', { name: '2枚の写真を受け取りました', exact: true }).waitFor({ timeout: 60_000 });
	await a.getByRole('status').filter({ hasText: '同じデータ' }).waitFor();
	await verifySelectedPhotos(a);
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
	assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
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
	await clickButton(b, '写真を保存・共有する');
	await shareFallback(b);
	await beginPendingShare(b);
	await clickButton(b, '画面内の写真を削除する');
	await b.evaluate(() => window.finishShare());
	await verifyDiscarded(b);
}

async function shareFallback(b) {
	await b.getByRole('status').filter({ hasText: 'このブラウザでは写真を共有できません' }).waitFor();
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
	await verifyAddingPhotos(a, photo);
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
	await finishScenarios(a, b, photo);
}

async function finish(a, b) {
	await saveAndDiscard(b);
	await clickButton(a, '同じ写真をもう一度共有');
	await readQr(a);
	await clickButton(a, '共有を取り消す');
	await disconnect(a, b);
	assert.deepEqual(errors, []);
}

try {
	await scenario();
	console.log(
		'PASS: group QR with 5 recipients, dual approval, sequential RTC, capacity, closure, hashes; passkey registration/logout/login, authentication-first sender flow, short-lived links, revoke, reject, single use, no RTC before approval, multi-photo RTC, SHA-256 match, mobile layout, save fallback, discard, disconnect without location permission'
	);
} finally {
	for (const context of contexts) {
		await context.close();
	}
	await browser.close();
}

async function verifyPasskeyLogin(page) {
	await virtualPasskey(page);
	await page.getByLabel('初めての方はユーザーIDを入力').fill('Test Sender');
	await clickButton(page, 'パスキーを作成してはじめる');
	await loggedIn(page);
	await clickButton(page, 'ログアウト');
	await assertAuthScreen(page);
	await clickButton(page, 'パスキーでログイン');
	await loggedIn(page);
}

async function loggedIn(page) {
	await page.getByRole('status').filter({ hasText: 'Test Sender としてログイン中' }).waitFor();
}

async function assertAuthScreen(page) {
	await page.getByRole('heading', { name: '初めての方は新規登録' }).waitFor();
	assert.equal(await page.locator('input[type=file]').count(), 0);
	assert.equal(await page.getByRole('button', { name: '写真を渡す', exact: true }).count(), 0);
}

async function prepareSender(page) {
	await assertAuthScreen(page);
	await verifyPasskeyLogin(page);
	await page.reload();
	await loggedIn(page);
	const photo = await selectPhotos(page);
	await page.screenshot({ path: '/tmp/pico-drop-auth.png', fullPage: true });
	return photo;
}

async function verifySelectedPhotos(page) {
	const photos = page.getByRole('region', { name: '今回の共有の写真' });
	await photos.getByText('trip.jpg', { exact: true }).waitFor();
	await photos.getByText('friends.jpg', { exact: true }).waitFor();
	assert.equal(await photos.locator('img').count(), 2);
	await photos.locator('img').evaluateAll(decodePreviews);
}

function decodePreviews(images) {
	return Promise.all(images.map((image) => image.decode()));
}

async function verifyAddingPhotos(page, photo) {
	const input = page.locator('.picker input');
	const [first, next] = photoFiles(photo);
	await input.setInputFiles(first);
	await page.getByText('trip.jpg', { exact: true }).waitFor();
	await input.setInputFiles(next);
	await verifySelectedPhotos(page);
	await rejectExcessPhotos(page, photo);
}

async function rejectExcessPhotos(page, photo) {
	const files = excessPhotos(photo);
	await page.locator('.picker input').setInputFiles(files);
	await page.getByRole('alert').filter({ hasText: '10枚・合計50MBまで' }).waitFor();
	await verifySelectedPhotos(page);
}

async function verifyDiscarded(b) {
	await b.getByRole('heading', { name: '受け取りは終了しました' }).waitFor();
	await verifyOldNoticeCleared(b);
	assert.equal(await b.locator('.gallery a').count(), 0);
	await b.getByRole('status').filter({ hasText: '画面内の写真を削除しました' }).waitFor();
}

function excessPhotos(photo) {
	return Array.from({ length: 9 }, (_, i) => ({
		name: `extra-${i}.jpg`,
		mimeType: 'image/jpeg',
		buffer: photo
	}));
}

async function beginPendingShare(page) {
	await page.evaluate(() =>
		Object.defineProperty(navigator, 'canShare', {
			configurable: true,
			value: () => true
		})
	);
	await page.evaluate(mockPendingShare);
	await clickButton(page, '写真を保存・共有する');
}

function mockPendingShare() {
	const pending = Promise.withResolvers();
	window.finishShare = pending.resolve;
	Object.defineProperty(navigator, 'share', {
		configurable: true,
		value: () => pending.promise
	});
}

async function verifyOldNoticeCleared(b) {
	assert.equal(await b.getByText('このブラウザでは写真を共有できません', { exact: false }).count(), 0);
}

async function groupScenario(sender, photo) {
	await clickButton(sender, 'みんなに渡す（最大5人）');
	const link = await readQr(sender);
	const guests = await groupGuests(link);
	await verifyGroupCapacity(link);
	await groupTransfer(sender, guests);
	await verifyGroupPhotos(guests, photo);
	await finishGroup(sender, link);
}

async function groupGuests(link) {
	const guests = [];
	for (let i = 0; i < 5; i++) {
		const guest = await device();
		await join(guest, link);
		await clickButton(guest, '受け取る');
		guests.push(guest);
	}
	return guests;
}

async function verifyGroupCapacity(link) {
	const extra = await device();
	await extra.goto(link);
	await extra.getByRole('alert').filter({ hasText: '5人まで' }).waitFor();
	await extra.close();
}

async function groupTransfer(sender, guests) {
	await noGroupPeers(guests);
	const release = await holdIce(guests[0]);
	await approveAll(sender);
	await verifyGroupQueue(sender, guests);
	release();
	await allGroupReceived(guests);
}

async function holdIce(page) {
	const pending = Promise.withResolvers();
	await page.route('**/api/ice', async (route) => {
		await pending.promise;
		await route.continue();
	});
	return pending.resolve;
}

async function approveAll(sender) {
	for (let i = 0; i < 5; i++) {
		await sender.getByRole('button', { name: 'この相手に渡す', exact: true }).first().click();
	}
}

async function groupReceived(guest) {
	await guest.getByRole('heading', { name: '2枚の写真を受け取りました', exact: true }).waitFor({ timeout: 60_000 });
	assert.equal(await peerCount(guest), 1);
}

async function finishGroup(sender, link) {
	await sender.locator('li').filter({ hasText: '受信完了' }).nth(4).waitFor();
	await verifyLayout(sender);
	await sender.screenshot({
		path: '/tmp/pico-drop-group-complete.png',
		fullPage: true
	});
	await clickButton(sender, '配布を終了する');
	await checkGroupClosed(link);
}

async function finishScenarios(a, b, photo) {
	await finish(a, b);
	await groupScenario(a, photo);
}

async function verifyGroupPhotos(guests, photo) {
	for (const guest of guests) {
		await verifyPhotos(guest, photo);
	}
}

async function noGroupPeers(guests) {
	for (const guest of guests) {
		assert.equal(await peerCount(guest), 0);
	}
}

async function verifyGroupQueue(sender, guests) {
	await sender.getByText('順番待ち', { exact: true }).first().waitFor();
	await noGroupPeers(guests.slice(1));
	await sender.screenshot({
		path: '/tmp/pico-drop-group-queue.png',
		fullPage: true
	});
}

async function allGroupReceived(guests) {
	for (const guest of guests) {
		await groupReceived(guest);
	}
}

async function checkGroupClosed(link) {
	const late = await device();
	await late.goto(link);
	await late.getByRole('alert').filter({ hasText: '有効期限が切れた' }).waitFor();
	assert.deepEqual(errors, []);
}
