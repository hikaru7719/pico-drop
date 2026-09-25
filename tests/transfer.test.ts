import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhotoReceiver, digest, sendPhotos } from '../frontend/src/lib/webrtc/transfer.ts';
import { describePhotos, formatBytes, sharePhotos } from '../frontend/src/lib/photos/index.ts';
const data = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]).buffer;
const meta = { id: 'p', name: 'photo.jpg', type: 'image/jpeg', size: data.byteLength };
test('multiple photos are received byte-for-byte and complete only after final marker', async () => {
	const files: File[] = [];
	let complete = false;
	const r = new PhotoReceiver(
		[meta, { ...meta, id: 'p2' }],
		() => {},
		(f) => files.push(f),
		() => {
			complete = true;
		}
	);
	for (const id of ['p', 'p2']) {
		await r.consume(JSON.stringify({ type: 'file', id, sha256: await digest(data) }));
		await r.consume(data.slice(0, 4));
		await r.consume(data.slice(4));
		assert.equal(complete, false);
		await r.consume(JSON.stringify({ type: 'file-end', id }));
	}
	await r.consume('{"type":"done"}');
	assert.equal(complete, true);
	assert.equal(files.length, 2);
	for (const f of files) assert.deepEqual(await f.arrayBuffer(), data);
});
test('receiver rejects oversized, early, truncated and corrupt data', async () => {
	const make = () =>
		new PhotoReceiver(
			[meta],
			() => {},
			() => {},
			() => {}
		);
	await assert.rejects(make().consume(data));
	await assert.rejects(make().consume('{"type":"done"}'));
	let r = make();
	await r.consume(JSON.stringify({ type: 'file', id: 'p', sha256: await digest(data) }));
	await assert.rejects(r.consume(new ArrayBuffer(9)));
	r = make();
	await r.consume(JSON.stringify({ type: 'file', id: 'p', sha256: '0'.repeat(64) }));
	await r.consume(data);
	await assert.rejects(r.consume('{"type":"file-end","id":"p"}'));
	r = make();
	await r.consume(JSON.stringify({ type: 'file', id: 'p', sha256: await digest(data) }));
	await r.consume(data.slice(0, 4));
	await assert.rejects(r.consume('{"type":"file-end","id":"p"}'));
	r = make();
	r.dispose();
	await assert.rejects(r.consume(data));
});
test('sender respects cancellation and channel backpressure', async () => {
	const controller = new AbortController();
	controller.abort();
	let sends = 0;
	const channel = {
		readyState: 'open',
		bufferedAmount: 0,
		send: () => {
			sends++;
		}
	} as unknown as RTCDataChannel;
	await assert.rejects(
		sendPhotos(channel, [new File([data], 'photo.jpg')], [meta], controller.signal, () => {})
	);
	assert.equal(sends, 0);
	const live = new AbortController();
	const blocked = Object.assign(new EventTarget(), {
		readyState: 'open',
		bufferedAmount: 1024 * 1024,
		bufferedAmountLowThreshold: 0,
		send: () => {
			sends++;
		}
	});
	const pending = sendPhotos(
		blocked as unknown as RTCDataChannel,
		[new File([data], 'photo.jpg')],
		[meta],
		live.signal,
		() => {}
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sends, 0);
	live.abort();
	await assert.rejects(pending);
});
test('photo classification uses file bytes and preserves HEIC, rejects renamed non-photos', async () => {
	const [jpeg] = await describePhotos([new File([data], 'camera.heic', { type: 'image/heic' })]);
	assert.equal(jpeg.type, 'image/jpeg');
	await assert.rejects(
		describePhotos([new File(['not a photo'], 'fake.jpg', { type: 'image/jpeg' })])
	);
	const heic = new Uint8Array(24);
	heic.set(new TextEncoder().encode('ftypheic'), 4);
	const [meta] = await describePhotos([new File([heic], 'camera.heic', { type: 'image/heic' })]);
	assert.equal(meta.type, 'image/heic');
	assert.equal(meta.name, 'camera.heic');
});

test('share cancellation and completion remain distinct from confirmed photo-library saving', async () => {
	const files = [new File([data], 'photo.jpg', { type: 'image/jpeg' })];
	Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
	Object.defineProperty(navigator, 'share', {
		configurable: true,
		value: async () => {
			throw new DOMException('Cancelled', 'AbortError');
		}
	});
	assert.equal(await sharePhotos(files), 'cancelled');
	Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
	assert.equal(await sharePhotos(files), 'shared');
	Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
	assert.equal(await sharePhotos(files), 'unsupported');
});

test('byte labels retain precision for small photos and zero progress', () => {
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(7), '7 B');
	assert.equal(formatBytes(15), '15 B');
	assert.equal(formatBytes(1024), '1 KB');
	assert.equal(formatBytes(1024 * 1024), '1.0 MB');
});
