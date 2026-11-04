import type { SendChannel } from './ports';
import { afterEach, onTestFinished, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { PhotoReceiver, digest, sendPhotos, TransferProgress } from './transfer.ts';
import { LIMITS } from '../../../../shared/protocol.ts';
const data = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]).buffer;
const meta = {
	id: 'p',
	name: 'photo.jpg',
	type: 'image/jpeg',
	size: data.byteLength
};

afterEach(() => vi.restoreAllMocks());

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
	messages: (string | ArrayBuffer | Uint8Array<ArrayBuffer>)[] = [];
	controller = new AbortController();

	send(message: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
		this.sends++;
		this.messages.push(message);
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
	sender.bufferedAmount = 2 * 1024 * 1024;
	const pending = sender.start();
	await waitForDrain(sender);
	assert.equal(sender.sends, 0);
	sender.controller.abort();
	await assert.rejects(pending);
});

function waitForDrain(sender: SenderFixture) {
	const listen = vi.spyOn(sender, 'addEventListener');
	return vi.waitFor(() => assert.ok(listen.mock.calls.some(([event]) => event === 'bufferedamountlow')));
}

function largePhoto(size: number) {
	const bytes = new Uint8Array(size).fill(37);
	bytes.set(new Uint8Array(data));
	return new File([bytes], `photo-${size}.jpg`, { type: meta.type });
}

class RoundTripFixture {
	channel = new SenderFixture();
	files = [largePhoto(LIMITS.chunk + 13), largePhoto(LIMITS.chunk * 2 + 17), largePhoto(LIMITS.chunk * 3 + 19)];
	metadata = this.files.map((file, i) => ({ ...meta, id: `p${i}`, name: file.name, size: file.size }));
	received = new ReceiverFixture(this.metadata);
	progress: number[] = [];

	send() {
		return sendPhotos({
			channel: this.channel,
			files: this.files,
			metadata: this.metadata,
			signal: this.channel.controller.signal,
			progress: (n) => this.progress.push(n)
		});
	}

	async receive() {
		for (const message of this.channel.messages) {
			const value =
				message instanceof Uint8Array
					? message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength)
					: message;
			await this.received.receiver.consume(value);
		}
	}
}

test('sender preserves multiple photos across chunk boundaries and reports the exact total', async () => {
	const f = new RoundTripFixture();
	await f.send();
	await f.receive();
	assert.equal(f.received.complete, true);
	const total = f.files.reduce((total, file) => total + file.size, 0);
	assert.equal(f.progress.at(-1), total);
	await assertRoundTrip(f);
});

async function assertRoundTrip(f: RoundTripFixture) {
	assert.equal(f.received.files.length, f.files.length);
	for (const [index, file] of f.received.files.entries()) {
		assert.equal(file.name, f.files[index].name);
		assert.deepEqual(await file.arrayBuffer(), await f.files[index].arrayBuffer());
	}
}

test('sender resumes when the channel buffer drains', async () => {
	const sender = new SenderFixture();
	sender.bufferedAmount = 2 * 1024 * 1024;
	const pending = sender.start();
	await waitForDrain(sender);
	sender.bufferedAmount = 0;
	sender.dispatchEvent(new Event('bufferedamountlow'));
	await pending;
	assert.equal(sender.messages.at(-1), '{"type":"done"}');
});

class ProgressFixture {
	clock = vi.spyOn(performance, 'now').mockReturnValue(0);
	values: number[] = [];
	progress = new TransferProgress(100, (bytes) => this.values.push(bytes));

	constructor() {
		onTestFinished(() => this.clock.mockRestore());
	}

	update(bytes: number, time: number) {
		this.clock.mockReturnValue(time);
		this.progress.update(bytes);
	}
}

test('progress is limited to 50ms intervals and always publishes the exact final bytes', () => {
	const f = new ProgressFixture();
	f.update(1, 0);
	f.update(20, 49);
	f.update(50, 50);
	f.update(90, 60);
	f.update(100, 60);
	assert.deepEqual(f.values, [1, 50, 100]);
});
