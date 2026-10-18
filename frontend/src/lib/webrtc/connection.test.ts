import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { LIMITS } from '../../../../shared/protocol.ts';
import { createTransferConnection, TransferConnection } from './connection';
import { digest } from './transfer';

const data = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]).buffer;
const photo = { id: 'photo', name: 'photo.jpg', type: 'image/jpeg', size: 8 };
const transfer = {
	type: 'requested' as const,
	id: 'transfer',
	files: [photo],
	from: { id: 'sender', name: 'Sender' },
	to: { id: 'receiver', name: 'Receiver' }
};
class Channel extends EventTarget {
	readyState = 'connecting';
	bufferedAmount = 0;
	binaryType = '';
	onopen?: () => void;
	onclose?: () => void;
	onerror?: () => void;
	onmessage?: (event: { data: unknown }) => void;
	send = vi.fn();
	close = vi.fn();
	rtc() {
		return this as unknown as RTCDataChannel;
	}
	message(value: unknown) {
		this.onmessage!({ data: value });
	}
}
class ConnectionFixture {
	abort = new AbortController();
	channel = new Channel();
	callbacks = {
		files: [new File([data], photo.name, { type: photo.type })],
		total: 8,
		bytes: vi.fn(() => 8),
		completed: vi.fn(() => false),
		open: vi.fn(),
		complete: vi.fn(),
		touch: vi.fn(),
		fail: vi.fn(),
		send: vi.fn(),
		progress: vi.fn(),
		received: vi.fn(),
		peer: vi.fn(),
		receiver: vi.fn()
	};
	connection: TransferConnection;
	constructor(sender = false) {
		this.connection = new TransferConnection(
			transfer,
			this.abort.signal,
			sender,
			this.callbacks
		);
		onTestFinished(() => this.abort.abort());
	}
	attach() {
		this.connection.attach(this.channel.rtc());
	}
	async receiveFile() {
		const header = { type: 'file', id: photo.id, sha256: await digest(data) };
		this.channel.message(JSON.stringify(header));
		this.channel.message(data);
		this.channel.message('{"type":"file-end","id":"photo"}');
		this.channel.message('{"type":"done"}');
		await vi.waitFor(() =>
			expect(this.channel.send).toHaveBeenCalledWith('{"type":"verified"}')
		);
	}
}
afterEach(() => vi.unstubAllGlobals());

test('receiver queues chunks and confirms only after the final acknowledgement', async () => {
	const f = new ConnectionFixture();
	f.attach();
	await f.receiveFile();
	expect(f.callbacks.complete).not.toHaveBeenCalled();
	f.channel.message('{"type":"verified-ack"}');
	await vi.waitFor(() => expect(f.callbacks.complete).toHaveBeenCalledOnce());
	assertCompleteSignal(f);
	await assertReceived(f);
});
async function assertReceived(f: ConnectionFixture) {
	expect(f.callbacks.received).toHaveBeenCalledOnce();
	expect(await f.callbacks.received.mock.calls[0][0].arrayBuffer()).toEqual(
		data
	);
	expect(f.callbacks.progress).toHaveBeenCalledWith(8);
	expect(f.channel.binaryType).toBe('arraybuffer');
}
test('sender streams photos and accepts confirmation only after all bytes are sent', async () => {
	const f = new ConnectionFixture(true);
	f.channel.readyState = 'open';
	f.attach();
	await vi.waitFor(() =>
		expect(f.channel.send).toHaveBeenCalledWith('{"type":"done"}')
	);
	f.channel.message('{"type":"verified"}');
	assertSenderComplete(f);
});
test.each([
	['wrong', 8],
	['{"type":"verified"}', 7]
] as const)(
	'sender rejects invalid confirmation %s at %s bytes',
	(message, bytes) => {
		const f = new ConnectionFixture(true);
		f.callbacks.bytes.mockReturnValue(bytes);
		f.attach();
		f.channel.message(message);
		expect(f.callbacks.fail.mock.calls[0][0].message).toContain(
			'不正な受信確認'
		);
		expect(f.callbacks.complete).not.toHaveBeenCalled();
	}
);
test('duplicate and aborted channels are closed without installing handlers', () => {
	const f = new ConnectionFixture();
	f.attach();
	const duplicate = new Channel();
	f.connection.attach(duplicate.rtc());
	expect(duplicate.close).toHaveBeenCalledOnce();
	f.abort.abort();
	f.connection.attach(duplicate.rtc());
	expect(duplicate.close).toHaveBeenCalledTimes(2);
});
test('channel errors and premature closes fail an active transfer', () => {
	const f = new ConnectionFixture();
	f.attach();
	f.channel.onerror!();
	f.channel.onclose!();
	expect(f.callbacks.fail).toHaveBeenCalledTimes(2);
	f.callbacks.completed.mockReturnValue(true);
	f.channel.onclose!();
	expect(f.callbacks.fail).toHaveBeenCalledTimes(2);
});
test('abort ignores open, confirmation, queued data and transport errors', async () => {
	const f = new ConnectionFixture();
	f.attach();
	f.channel.message(data);
	f.abort.abort();
	f.channel.onopen!();
	f.connection.confirm(f.channel.rtc(), '{"type":"verified"}');
	await assertAborted(f);
});
async function assertAborted(f: ConnectionFixture) {
	f.channel.onerror!();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.callbacks.fail).not.toHaveBeenCalled();
	expect(f.callbacks.open).not.toHaveBeenCalled();
	expect(f.callbacks.received).not.toHaveBeenCalled();
}
test.each([new ArrayBuffer(LIMITS.chunk + 1), 'x'.repeat(1025)])(
	'oversized messages fail before processing',
	(value) => {
		const f = new ConnectionFixture();
		f.attach();
		f.channel.message(value);
		expect(f.callbacks.fail.mock.calls[0][0].message).toContain(
			'受信サイズの上限'
		);
	}
);
test('malformed incoming messages fail through the serial processing queue', async () => {
	const f = new ConnectionFixture();
	f.attach();
	f.channel.message('{}');
	await vi.waitFor(() => expect(f.callbacks.fail).toHaveBeenCalledOnce());
	expect(f.callbacks.complete).not.toHaveBeenCalled();
});
test('send failure is reported when an opened channel is no longer usable', async () => {
	const f = new ConnectionFixture(true);
	f.attach();
	f.channel.onopen!();
	await vi.waitFor(() => expect(f.callbacks.fail).toHaveBeenCalledOnce());
	expect(f.callbacks.fail.mock.calls[0][0].message).toContain(
		'接続が切れました'
	);
});
class BrowserPeer {
	static latest: BrowserPeer;
	localDescription = { type: 'offer', sdp: 'sdp' };
	onicecandidate?: (event: { candidate: unknown }) => void;
	ondatachannel?: (event: { channel: RTCDataChannel }) => void;
	onconnectionstatechange?: () => void;
	connectionState = 'failed';
	createOffer = vi.fn(async () => this.localDescription);
	setLocalDescription = vi.fn(async () => {});
	createDataChannel = vi.fn(() => new Channel().rtc());
	close = vi.fn();
	constructor(readonly config: RTCConfiguration) {
		BrowserPeer.latest = this;
	}
}
test.each([true, false])(
	'connect wires the browser peer for sender=%s',
	async (sender) => {
		vi.stubGlobal('RTCPeerConnection', BrowserPeer);
		const f = new ConnectionFixture(sender);
		await connectBrowser(f, sender);
		assertPeerWiring(f, sender);
	}
);
function assertPeerWiring(f: ConnectionFixture, sender: boolean) {
	const pc = BrowserPeer.latest;
	expect(pc.config.iceServers).toEqual([{ urls: 'stun:example.com' }]);
	expect(pc.createOffer).toHaveBeenCalledTimes(Number(sender));
	pc.ondatachannel!({ channel: new Channel().rtc() });
	pc.onconnectionstatechange!();
	expect(f.callbacks.fail).toHaveBeenCalledOnce();
	assertSignalLifecycle(f, pc);
}
function assertSignalLifecycle(f: ConnectionFixture, pc: BrowserPeer) {
	pc.onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'ice' }) } });
	expect(f.callbacks.send).toHaveBeenLastCalledWith({
		type: 'signal',
		id: transfer.id,
		signal: { candidate: { candidate: 'ice' } }
	});
	assertAbortedSignal(f, pc);
}
function assertAbortedSignal(f: ConnectionFixture, pc: BrowserPeer) {
	f.callbacks.send.mockClear();
	f.abort.abort();
	pc.onicecandidate!({ candidate: { toJSON: () => ({ candidate: 'late' }) } });
	expect(f.callbacks.send).not.toHaveBeenCalled();
	f.callbacks.peer.mock.calls[0][0].close();
}

function assertCompleteSignal(f: ConnectionFixture) {
	expect(f.callbacks.send).toHaveBeenCalledWith({
		type: 'complete',
		id: transfer.id
	});
}
function assertSenderComplete(f: ConnectionFixture) {
	expect(f.callbacks.complete).toHaveBeenCalledOnce();
	expect(f.channel.send).toHaveBeenLastCalledWith('{"type":"verified-ack"}');
	expect(f.callbacks.open).toHaveBeenCalledOnce();
}
type ConnectionArgs = Parameters<typeof createTransferConnection>;
async function connectBrowser(f: ConnectionFixture, sender: boolean) {
	const args: ConnectionArgs = [transfer, f.abort.signal, sender, f.callbacks];
	const connection = createTransferConnection(...args);
	await connection.connect({
		iceServers: [{ urls: 'stun:example.com' }],
		relay: false
	});
}
