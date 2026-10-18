import type { SendChannel } from './ports';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PhotoReceiver, digest, sendPhotos } from './transfer.ts';
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

test('multiple photos are received byte-for-byte and complete only after final marker', async () => {
	const f = new ReceiverFixture([meta, { ...meta, id: 'p2' }]);
	for (const id of ['p', 'p2']) {
		await f.photo(id);
	}
	await f.receiver.consume('{"type":"done"}');
	await assertReceivedFiles(f);
});
test('receiver rejects early and disposed data', async () => {
	const f = new ReceiverFixture();
	await assert.rejects(f.receiver.consume(data));
	await assert.rejects(f.receiver.consume('{"type":"done"}'));
	f.receiver.dispose();
	await assert.rejects(f.receiver.consume(data));
});
test('receiver rejects oversized data', async () => {
	const f = new ReceiverFixture();
	await f.begin();
	await assert.rejects(f.receiver.consume(new ArrayBuffer(9)));
});
test('receiver rejects corrupt data', async () => {
	const f = new ReceiverFixture();
	await f.begin('p', '0'.repeat(64));
	await f.receiver.consume(data);
	await assert.rejects(f.receiver.consume('{"type":"file-end","id":"p"}'));
});
test('receiver rejects truncated data', async () => {
	const f = new ReceiverFixture();
	await f.begin();
	await f.receiver.consume(data.slice(0, 4));
	await assert.rejects(f.receiver.consume('{"type":"file-end","id":"p"}'));
});
class SenderFixture extends EventTarget implements SendChannel {
	readyState: RTCDataChannelState = 'open';
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	sends = 0;
	controller = new AbortController();

	send() {
		this.sends++;
	}

	start() {
		return sendPhotos({
			channel: this,
			files: [new File([data], 'photo.jpg')],
			metadata: [meta],
			signal: this.controller.signal,
			progress: () => {}
		});
	}
}
test('sender respects cancellation', async () => {
	const sender = new SenderFixture();
	sender.controller.abort();
	await assert.rejects(sender.start());
	assert.equal(sender.sends, 0);
});
test('sender respects channel backpressure', async () => {
	const sender = new SenderFixture();
	sender.bufferedAmount = 1024 * 1024;
	const pending = sender.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(sender.sends, 0);
	sender.controller.abort();
	await assert.rejects(pending);
});
