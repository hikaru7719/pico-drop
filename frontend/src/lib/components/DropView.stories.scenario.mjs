// Run against `mise run //frontend:storybook`; use the same Playwright runtime as browser.mjs.
import assert from 'node:assert/strict';
const { chromium } = await import(
	process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const baseURL = process.env.STORYBOOK_URL || 'http://127.0.0.1:6006';
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH
		? { executablePath: process.env.CHROME_PATH }
		: {})
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const senderStories = [
	'photos-selected',
	'link-ready',
	'sending-request',
	'transferring',
	'sent'
];
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
	const stories = Object.values(index.entries).filter(
		(entry) => entry.type === 'story'
	);
	assert.equal(stories.length, 21);
	for (const story of stories) {
		await page.goto(
			`${baseURL}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`
		);
		await page
			.locator('#storybook-root')
			.locator(story.title.startsWith('画面/') ? 'main' : '.discovery')
			.waitFor();
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth
			),
			true,
			story.name
		);
	}
	await page.goto(
		`${baseURL}/iframe.html?id=${encodeURIComponent('画面-写真を共有--peer-connecting')}&viewMode=story`
	);
	await page.locator('.transfer').waitFor();
	assert.equal(
		await page.getByRole('heading', { name: '目の前の人に、写真を。' }).count(),
		0
	);
	await verifyPhotoContext();
	await verifyReceivedActions();
	assert.deepEqual(errors, []);
	assert.deepEqual(apiCalls, []);
	console.log(
		`PASS: ${stories.length} stories render on mobile without application API calls or page errors`
	);
} finally {
	await browser.close();
}

async function story(name) {
	await page.goto(
		`${baseURL}/iframe.html?id=${encodeURIComponent('画面-写真を共有--' + name)}&viewMode=story`
	);
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
	const editable = ['photos-selected', 'sent'].includes(name);
	assert.equal(await photos.getByRole('button').count(), editable ? 1 : 0);
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
