import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	PhotoReceiver,
	digest,
	sendPhotos
} from '../frontend/src/lib/webrtc/transfer.ts';
import {
	describePhotos,
	formatBytes,
	sharePhotos
} from '../frontend/src/lib/photos/index.ts';
const data = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]).buffer;
const meta = {
	id: 'p',
	name: 'photo.jpg',
	type: 'image/jpeg',
	size: data.byteLength
};

class ReceiverFixture {
	files: File[] = [];
	complete = false;
	receiver: PhotoReceiver;
	constructor(metadata = [meta]) {
		this.receiver = new PhotoReceiver(
			metadata,
			() => {},
			(f) => this.files.push(f),
			() => {
				this.complete = true;
			}
		);
	}
	async begin(id = 'p', sha256: string | null = null) {
		await this.receiver.consume(
			JSON.stringify({
				type: 'file',
				id,
				sha256: sha256 ?? (await digest(data))
			})
		);
	}
	async photo(id: string) {
		await this.begin(id);
		await this.receiver.consume(data.slice(0, 4));
		await this.receiver.consume(data.slice(4));
		assert.equal(this.complete, false);
		await this.receiver.consume(JSON.stringify({ type: 'file-end', id }));
	}
}
async function assertReceivedFiles(f: ReceiverFixture) {
	assert.equal(f.complete, true);
	assert.equal(f.files.length, 2);
	for (const file of f.files) {
		assert.deepEqual(await file.arrayBuffer(), data);
	}
}
void test('multiple photos are received byte-for-byte and complete only after final marker', async () => {
	const f = new ReceiverFixture([meta, { ...meta, id: 'p2' }]);
	for (const id of ['p', 'p2']) {
		await f.photo(id);
	}
	await f.receiver.consume('{"type":"done"}');
	await assertReceivedFiles(f);
});
void test('receiver rejects early and disposed data', async () => {
	const f = new ReceiverFixture();
	await assert.rejects(f.receiver.consume(data));
	await assert.rejects(f.receiver.consume('{"type":"done"}'));
	f.receiver.dispose();
	await assert.rejects(f.receiver.consume(data));
});
void test('receiver rejects oversized data', async () => {
	const f = new ReceiverFixture();
	await f.begin();
	await assert.rejects(f.receiver.consume(new ArrayBuffer(9)));
});
void test('receiver rejects corrupt data', async () => {
	const f = new ReceiverFixture();
	await f.begin('p', '0'.repeat(64));
	await f.receiver.consume(data);
	await assert.rejects(f.receiver.consume('{"type":"file-end","id":"p"}'));
});
void test('receiver rejects truncated data', async () => {
	const f = new ReceiverFixture();
	await f.begin();
	await f.receiver.consume(data.slice(0, 4));
	await assert.rejects(f.receiver.consume('{"type":"file-end","id":"p"}'));
});
class SenderFixture extends EventTarget {
	readyState = 'open';
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	sends = 0;
	controller = new AbortController();
	send() {
		this.sends++;
	}
	start() {
		return sendPhotos({
			channel: this as unknown as RTCDataChannel,
			files: [new File([data], 'photo.jpg')],
			metadata: [meta],
			signal: this.controller.signal,
			progress: () => {}
		});
	}
}
void test('sender respects cancellation', async () => {
	const sender = new SenderFixture();
	sender.controller.abort();
	await assert.rejects(sender.start());
	assert.equal(sender.sends, 0);
});
void test('sender respects channel backpressure', async () => {
	const sender = new SenderFixture();
	sender.bufferedAmount = 1024 * 1024;
	const pending = sender.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sender.sends, 0);
	sender.controller.abort();
	await assert.rejects(pending);
});
void test('photo classification uses file bytes', async () => {
	const [jpeg] = await describePhotos([
		new File([data], 'camera.heic', { type: 'image/heic' })
	]);
	assert.equal(jpeg.type, 'image/jpeg');
});
void test('photo classification rejects renamed non-photos', async () => {
	const fake = new File(['not a photo'], 'fake.jpg', { type: 'image/jpeg' });
	await assert.rejects(describePhotos([fake]));
});
void test('photo classification preserves HEIC', async () => {
	const heic = new Uint8Array(24);
	heic.set(new TextEncoder().encode('ftypheic'), 4);
	const [photo] = await describePhotos([
		new File([heic], 'camera.heic', { type: 'image/heic' })
	]);
	assert.equal(photo.type, 'image/heic');
	assert.equal(photo.name, 'camera.heic');
});
function mockShare(canShare: boolean, share: () => Promise<void>) {
	Object.defineProperty(navigator, 'canShare', {
		configurable: true,
		value: () => canShare
	});
	Object.defineProperty(navigator, 'share', {
		configurable: true,
		value: share
	});
}
const shareFiles = [new File([data], 'photo.jpg', { type: 'image/jpeg' })];
void test('share cancellation and completion remain distinct from confirmed photo-library saving', async () => {
	mockShare(true, async () => {
		throw new DOMException('Cancelled', 'AbortError');
	});
	assert.equal(await sharePhotos(shareFiles), 'cancelled');
	mockShare(true, async () => {});
	assert.equal(await sharePhotos(shareFiles), 'shared');
	mockShare(false, async () => {});
	assert.equal(await sharePhotos(shareFiles), 'unsupported');
});
void test('byte labels retain precision for small photos and zero progress', () => {
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(7), '7 B');
	assert.equal(formatBytes(15), '15 B');
	assert.equal(formatBytes(1024), '1 KB');
	assert.equal(formatBytes(1024 * 1024), '1.0 MB');
});
