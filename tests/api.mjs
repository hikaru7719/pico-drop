import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
	headless: true,
	...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
});
try {
	const page = await browser.newPage();
	await page.goto((process.env.TEST_URL || 'http://localhost:5173') + '/api/health');
	const result = await page.evaluate(async () => {
		const sockets = [];
		const open = async (token) => {
			const ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/ws');
			sockets.push(ws);
			const queue = [];
			let waiter;
			ws.onmessage = (e) => {
				const m = JSON.parse(e.data);
				if (waiter) {
					const resolve = waiter;
					waiter = undefined;
					resolve(m);
				} else queue.push(m);
			};
			const next = async (type) => {
				for (let i = 0; i < 20; i++) {
					const m =
						queue.shift() ||
						(await new Promise((resolve, reject) => {
							const timeout = setTimeout(() => reject(new Error('Timed out: ' + type)), 5000);
							waiter = (m) => {
								clearTimeout(timeout);
								resolve(m);
							};
						}));
					if (m.type === type) return m;
				}
				throw new Error('Missing ' + type);
			};
			await new Promise((resolve) => {
				ws.onopen = resolve;
			});
			ws.send(JSON.stringify({ type: 'auth', token }));
			return { ws, next, send: (m) => ws.send(JSON.stringify(m)) };
		};
		const session = async () => await (await fetch('/api/session', { method: 'POST' })).json();
		try {
			const sa = await session(),
				sb = await session(),
				sc = await session();
			const a = await open(sa.token),
				b = await open(sb.token),
				c = await open(sc.token);
			await a.next('ready');
			await b.next('ready');
			await c.next('ready');
			const location = { latitude: 35, longitude: 139, accuracy: 20 };
			a.send({ type: 'presence', location });
			b.send({ type: 'presence', location });
			let devices = [];
			while (!devices.some((d) => d.id === sb.id)) devices = (await a.next('nearby')).devices;
			const publicOnly = devices.every((d) => Object.keys(d).sort().join(',') === 'id,name');
			b.send({ type: 'presence', location: null });
			while (devices.some((d) => d.id === sb.id)) devices = (await a.next('nearby')).devices;
			b.send({ type: 'presence', location });
			while (!devices.some((d) => d.id === sb.id)) devices = (await a.next('nearby')).devices;
			a.send({
				type: 'request',
				to: sb.id,
				files: [{ id: 'p', name: 'photo.jpg', type: 'image/jpeg', size: 8 }]
			});
			const t = await a.next('requested');
			const receiverRequest = await b.next('requested');
			const answerHidden =
				receiverRequest.confirmation.kind === 'choose' &&
				!('word' in receiverRequest.confirmation) &&
				!('code' in receiverRequest) &&
				receiverRequest.confirmation.options.length === 8;
			const signal = {
				type: 'signal',
				id: t.id,
				signal: { description: { type: 'offer', sdp: 'test' } }
			};
			a.send(signal);
			const preAccept = (await a.next('error')).message;
			a.send({ type: 'accept', id: t.id });
			const senderAccept = (await a.next('error')).message;
			c.send({ type: 'cancel', id: t.id });
			const outsider = (await c.next('error')).message;
			const iceStatus = (
				await fetch('/api/ice', {
					method: 'POST',
					headers: { Authorization: 'Bearer ' + sa.token }
				})
			).status;
			b.send({ type: 'accept', id: t.id });
			await a.next('accepted');
			await b.next('accepted');
			a.send({ type: 'confirm', id: t.id, word: t.confirmation.word });
			const senderConfirm = (await a.next('error')).message;
			a.send(signal);
			const oneConfirm = (await a.next('error')).message;
			b.send({ type: 'confirm', id: t.id, word: t.confirmation.word });
			await a.next('start');
			await b.next('start');
			a.send(signal);
			const forwarded = await b.next('signal');
			a.send({ type: 'complete', id: t.id });
			const senderComplete = (await a.next('error')).message;
			b.send({ type: 'cancel', id: t.id });
			await a.next('ended');
			await b.next('ended');
			a.send(signal);
			const stale = (await a.next('error')).message;
			a.send({
				type: 'request',
				to: sb.id,
				files: [{ id: 'p', name: 'photo.jpg', type: 'image/jpeg', size: 8 }]
			});
			const wrongRequest = await a.next('requested');
			const choices = await b.next('requested');
			b.send({ type: 'accept', id: wrongRequest.id });
			await a.next('accepted');
			await b.next('accepted');
			b.send({
				type: 'confirm',
				id: wrongRequest.id,
				word: choices.confirmation.options.find((word) => word !== wrongRequest.confirmation.word)
			});
			const wrongSenderEnd = (await a.next('ended')).reason;
			const wrongReceiverEnd = (await b.next('ended')).reason;
			b.send({ type: 'confirm', id: wrongRequest.id, word: wrongRequest.confirmation.word });
			const retryAfterWrong = (await b.next('error')).message;
			const invalid = await open('0'.repeat(64));
			const invalidCode = await new Promise((resolve) => {
				invalid.ws.onclose = (e) => resolve(e.code);
			});
			a.ws.close();
			await new Promise((resolve) => {
				a.ws.onclose = resolve;
			});
			const replay = await open(sa.token);
			const replayCode = await new Promise((resolve) => {
				replay.ws.onclose = (e) => resolve(e.code);
			});
			return {
				wrongSenderEnd,
				wrongReceiverEnd,
				retryAfterWrong,
				publicOnly,
				answerHidden,
				senderConfirm,
				preAccept,
				senderAccept,
				outsider,
				iceStatus,
				oneConfirm,
				forwarded,
				senderComplete,
				stale,
				invalidCode,
				replayCode
			};
		} finally {
			for (const ws of sockets) ws.close();
		}
	});
	assert.equal(result.wrongSenderEnd, 'mismatch');
	assert.equal(result.wrongReceiverEnd, 'mismatch');
	assert.match(result.retryAfterWrong, /見つかりません/);
	assert.equal(result.publicOnly, true);
	assert.equal(result.answerHidden, true);
	assert.match(result.senderConfirm, /受信者/);
	assert.match(result.preAccept, /あいことば/);
	assert.match(result.oneConfirm, /あいことば/);
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
		'PASS: Origin checks, token validation/replay, no coordinate disclosure, receiver-only approval/completion, outsider rejection, receiver passphrase gate, TURN authorization, stale transfer rejection'
	);
} finally {
	await browser.close();
}
