// Run against `mise run //frontend:storybook`; use the same Playwright runtime as browser.mjs.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.STORYBOOK_URL || 'http://127.0.0.1:6006';
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const senderStories = ['photos-selected', 'link-ready', 'sending-request', 'transferring', 'sent'];
const errors = [];
const apiCalls = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('request', (request) => {
	if (new URL(request.url()).pathname.startsWith('/api/')) {
		apiCalls.push(request.url());
	}
});
try {
	const index = await (await fetch(`${baseURL}/index.json`)).json();
	const stories = Object.values(index.entries).filter((entry) => entry.type === 'story');
	assert.equal(stories.length, 25);
	for (const viewport of [
		{ width: 320, height: 568 },
		{ width: 390, height: 664 },
		{ width: 844, height: 390 }
	]) {
		await page.setViewportSize(viewport);
		for (const entry of stories) {
			await page.goto(`${baseURL}/iframe.html?id=${encodeURIComponent(entry.id)}&viewMode=story`);
			await page
				.locator('#storybook-root')
				.locator(entry.title.startsWith('画面/') ? 'main' : '.discovery')
				.waitFor();
			await page.evaluate(() => document.fonts.ready);
			await verifyNoOverflow(`${entry.name} at ${viewport.width}px`);
		}
		await verifyPreview();
		await verifyExpandedContent();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${baseURL}/iframe.html?id=${encodeURIComponent('画面-写真を共有--peer-connecting')}&viewMode=story`);
	await page.locator('.transfer').waitFor();
	assert.equal(await page.getByRole('heading', { name: '目の前の人に、写真を。' }).count(), 0);
	await verifyPhotoContext();
	await verifyReceivedActions();
	await verifyCompletion();
	await verifyPreview();
	assert.deepEqual(errors, []);
	assert.deepEqual(apiCalls, []);
	console.log(`PASS: ${stories.length} stories render on mobile without application API calls or page errors`);
} finally {
	await browser.close();
}

async function story(name) {
	await page.goto(`${baseURL}/iframe.html?id=${encodeURIComponent('画面-写真を共有--' + name)}&viewMode=story`);
	await page.locator('main').waitFor();
}

async function verifyPhotoContext() {
	for (const name of senderStories) {
		await verifySenderStory(name);
	}
}

async function verifySenderStory(name) {
	await story(name);
	const photos = page.getByRole('region', { name: '今回の共有の写真' });
	await photos.getByText('weekend.png', { exact: true }).waitFor();
	await verifyEditable(photos, name === 'photos-selected');
	await photos.locator('img').evaluate((img) => img.decode());
	assert.equal(await page.getByRole('heading', { level: 1 }).count(), 0);
}

async function visible(locator, expected = true) {
	assert.equal(await locator.isVisible(), expected);
}

async function verifyReceivedActions() {
	await story('unsupported-preview');
	await visible(page.getByRole('link', { name: /元の写真/ }));
	const conversion = control('button', 'JPEGに変換する');
	await visible(conversion, false);
	await page.getByText('プレビュー・JPEG変換', { exact: true }).click();
	await visible(conversion);
	await verifyConvertedPhoto();
}

async function verifyConvertedPhoto() {
	await story('converted-photo');
	await page.getByText('プレビュー・JPEG変換', { exact: true }).click();
	await visible(control('link', 'JPEGをダウンロードする'));
	await visible(control('button', 'JPEGを保存・共有する'));
	await visible(page.getByRole('link', { name: /元の写真/ }));
}

function control(role, name) {
	return page.getByRole(role, { name, exact: true });
}

async function verifyCompletion() {
	await story('sent');
	await visible(page.getByRole('heading', { name: '送信完了', exact: true }));
	await visible(control('button', '同じ写真をもう一度共有'));
	await visible(control('button', '別の写真を選ぶ'));
	await story('discarded');
	await visible(page.getByRole('heading', { name: '受け取りは終了しました' }));
	await visible(control('button', '再接続する'), false);
	await visible(page.getByText('新しいQR・共有リンク', { exact: false }));
}

async function verifyPreview() {
	await story('photos-selected');
	const trigger = control('button', 'weekend.pngを拡大する');
	await trigger.click();
	await visible(page.getByRole('dialog'));
	await verifyPreviewFits();
	await page.keyboard.press('Escape');
	await visible(page.getByRole('dialog'), false);
	await verifyFocus(trigger);
}

async function verifyPreviewFits() {
	const fits = await page.getByRole('dialog').evaluate((dialog) => dialog.scrollHeight <= dialog.clientHeight + 1);
	assert.equal(fits, true, 'preview photo must fit without scrolling');
	await verifyCloseFits();
}

async function verifyCloseFits() {
	const fits = await control('button', '閉じる').evaluate((button) => {
		const rect = button.getBoundingClientRect();
		return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
	});
	assert.equal(fits, true, 'preview close button must fit in the viewport');
}

async function verifyNoOverflow(message) {
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, message);
	const overflowing = await page
		.locator('button:visible')
		.evaluateAll((buttons) =>
			buttons.filter((button) => button.scrollWidth > button.clientWidth + 1).map((button) => button.textContent)
		);
	assert.deepEqual(overflowing, [], message);
}

async function verifyExpandedContent() {
	for (const name of ['link-ready', 'group-ready', 'converted-photo']) {
		await story(name);
		await page.locator('summary').click();
		await verifyNoOverflow(`${name} with expanded details`);
	}
}

async function verifyEditable(photos, editable) {
	assert.equal(await photos.getByRole('button', { name: /選択から外す/ }).count(), editable ? 1 : 0);
}

async function verifyFocus(trigger) {
	assert.equal(await trigger.evaluate((button) => button === document.activeElement), true);
}
