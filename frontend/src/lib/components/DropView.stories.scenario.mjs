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
	assert.equal(stories.length, 19);
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
		await page
			.getByRole('heading', { name: 'Photos, Just a Link Away.' })
			.count(),
		0
	);
	assert.deepEqual(errors, []);
	assert.deepEqual(apiCalls, []);
	console.log(
		`PASS: ${stories.length} stories render on mobile without application API calls or page errors`
	);
} finally {
	await browser.close();
}
