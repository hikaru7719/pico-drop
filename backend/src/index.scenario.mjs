import {
	registerPasskey,
	installAuthPost,
	verifyPasskeySecurity
} from '../../shared/passkey-fixture.mjs';
import assert from 'node:assert/strict';
const { chromium } = await import(
	process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH
		? { executablePath: process.env.CHROME_PATH }
		: {})
});
try {
	const page = await browser.newPage();
	await page.goto(
		(process.env.TEST_URL || 'http://localhost:5173') + '/api/health'
	);
	await installAuthPost(page);
	await registerPasskey(page);
	assert.deepEqual(await verifyPasskeySecurity(page), {
		name: 'Test Sender',
		replay: 400,
		forged: 400
	});
	await page.addScriptTag({
		path: new URL('./index.browser-fixture.js', import.meta.url).pathname
	});
	const result = await page.evaluate(() => window.runApiTests());
	assert.equal(result.sameRequest, true);
	assert.equal(result.distinctRooms, true);
	assert.equal(result.wrongRoomCode, 1008);
	assert.equal(result.photoRoom, true);
	assert.match(result.preAccept, /承諾/);
	assert.match(result.senderAccept, /受信者/);
	assert.match(result.senderComplete, /受信者/);
	assert.match(result.outsider, /見つかりません/);
	assert.match(result.stale, /見つかりません/);
	assert.equal(result.iceStatus, 403);
	assert.equal(result.forwarded.signal.description.sdp, 'test');
	assert.equal(result.invalidCode, 1008);
	assert.equal(result.replayCode, 1008);
	const crossOrigin = await page.request.post(
		(process.env.TEST_URL || 'http://localhost:5173') + '/api/session',
		{ headers: { Origin: 'https://example.invalid' } }
	);
	assert.equal(crossOrigin.status(), 403);
	console.log(
		'PASS: passkey registration/login, replay/forged signature rejection, Origin checks, token validation/replay, single-use link rendezvous, receiver-only approval/completion, outsider rejection, direct start after receiver approval, TURN authorization, stale transfer rejection'
	);
} finally {
	await browser.close();
}
