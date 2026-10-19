import type { DataChannel, PeerFactory, TransferPeer, TransferReceiver } from './ports';
import { LIMITS, type ServerMessage } from '../../../../shared/protocol.ts';
import { PhotoPeer } from './peer';
import { PhotoReceiver, sendPhotos } from './transfer';
import type { SignalingConnection } from './signaling';

type RequestInfo = Extract<ServerMessage, { type: 'requested' }>;
export type IceConfig = {
	iceServers: RTCIceServer[];
	relay: boolean;
	error?: string;
};
export interface TransferCallbacks {
	files: File[];
	total: number;
	bytes: () => number;
	completed: () => boolean;
	open: () => void;
	complete: () => void;
	touch: () => void;
	fail: (cause: unknown) => void;
	send: SignalingConnection['send'];
	progress: (bytes: number) => void;
	received: (file: File) => void;
	peer: (peer: TransferPeer) => void;
	receiver: (receiver: TransferReceiver) => void;
}

export interface Transfer {
	connect(config: IceConfig): Promise<void>;
}

const browserPeer: PeerFactory = (config) => new RTCPeerConnection(config);

export class TransferConnection implements Transfer {
	private attached = false;
	readonly transfer: RequestInfo;
	readonly signal: AbortSignal;
	readonly isSender: boolean;

	constructor(
		transfer: RequestInfo,
		signal: AbortSignal,
		isSender: boolean,
		readonly callbacks: TransferCallbacks
	) {
		this.transfer = transfer;
		this.signal = signal;
		this.isSender = isSender;
	}

	failIfActive(e: unknown) {
		if (!this.signal.aborted) {
			this.callbacks.fail(e);
		}
	}

	attach = (channel: DataChannel) => {
		if (this.attached || this.signal.aborted) {
			channel.close();
		} else {
			this.attachChannel(channel);
		}
	};

	attachChannel(channel: DataChannel) {
		this.attached = true;
		channel.binaryType = 'arraybuffer';
		this.listen(channel);
		if (this.isSender) {
			channel.onmessage = (event) => this.confirm(channel, event.data);
		} else {
			new IncomingChannel(this, channel);
		}
	}

	listen(channel: DataChannel) {
		channel.onopen = () => this.open(channel);
		if (channel.readyState === 'open') {
			this.open(channel);
		}
		channel.onerror = () => this.failIfActive(new Error('写真の転送に失敗しました。'));
		channel.onclose = () => this.closed();
	}

	closed() {
		if (!this.callbacks.completed()) {
			this.failIfActive(new Error('写真の転送が中断されました。'));
		}
	}

	open(channel: DataChannel) {
		if (this.signal.aborted) {
			return;
		}
		this.callbacks.open();
		this.callbacks.touch();
		if (this.isSender) {
			void this.sendFiles(channel).catch((e) => this.failIfActive(e));
		}
	}

	async sendFiles(channel: DataChannel) {
		await sendPhotos({
			channel,
			files: this.callbacks.files,
			metadata: this.transfer.files,
			signal: this.signal,
			progress: this.callbacks.progress
		});
	}

	confirm(channel: DataChannel, data: unknown) {
		if (this.signal.aborted) {
			return;
		}
		if (!this.validConfirmation(data)) {
			this.callbacks.fail(new Error('不正な受信確認です。'));
		} else {
			this.acknowledge(channel);
		}
	}

	validConfirmation(data: unknown) {
		return data === '{"type":"verified"}' && this.callbacks.bytes() === this.callbacks.total;
	}

	acknowledge(channel: DataChannel) {
		this.callbacks.complete();
		channel.send('{"type":"verified-ack"}');
		this.callbacks.touch();
	}

	sendSignal(s: Parameters<PhotoPeer['receive']>[0]) {
		if (!this.signal.aborted) {
			this.callbacks.send({ type: 'signal', id: this.transfer.id, signal: s });
		}
	}

	createPeer(config: IceConfig, factory: PeerFactory) {
		return new PhotoPeer(
			factory({ iceServers: config.iceServers }),
			(s) => this.sendSignal(s),
			this.attach,
			(e) => this.failIfActive(e)
		);
	}

	async connect(config: IceConfig, factory: PeerFactory = browserPeer) {
		const peer = this.createPeer(config, factory);
		this.callbacks.peer(peer);
		if (this.isSender) {
			await peer.offer(this.attach);
		}
	}
}
export type TransferFactory = (...args: ConstructorParameters<typeof TransferConnection>) => Transfer;

export const createTransferConnection: TransferFactory = (...args) => new TransferConnection(...args);

class IncomingChannel {
	private verified = false;
	private queue = Promise.resolve();
	private queuedBytes = 0;
	private current: PhotoReceiver;
	private transfer: TransferConnection;
	private channel: DataChannel;

	constructor(transfer: TransferConnection, channel: DataChannel) {
		this.transfer = transfer;
		this.channel = channel;
		this.current = this.createReceiver();
		this.transfer.callbacks.receiver(this.current);
		channel.onmessage = (event) => this.enqueue(event.data);
	}

	createReceiver() {
		return new PhotoReceiver(
			this.transfer.transfer.files,
			this.transfer.callbacks.progress,
			this.transfer.callbacks.received,
			() => this.verify()
		);
	}

	verify() {
		this.verified = true;
		this.channel.send('{"type":"verified"}');
		this.transfer.callbacks.touch();
	}

	validSize(data: unknown, size: number) {
		return size <= LIMITS.chunk && this.queuedBytes <= LIMITS.bytes && !(typeof data === 'string' && data.length > 1024);
	}

	enqueue(data: unknown) {
		const size = data instanceof ArrayBuffer ? data.byteLength : 0;
		this.queuedBytes += size;
		if (!this.validSize(data, size)) {
			this.transfer.callbacks.fail(new Error('受信サイズの上限を超えました。'));
		} else {
			this.queueMessage(data, size);
		}
	}

	queueMessage(data: unknown, size: number) {
		this.queue = this.queue.then(() => this.consume(data, size)).catch((e) => this.transfer.failIfActive(e));
	}

	async consume(data: unknown, size: number) {
		try {
			await this.receive(data);
		} finally {
			this.queuedBytes -= size;
		}
	}

	async receive(data: unknown) {
		if (this.transfer.signal.aborted) {
			return;
		}
		if (this.verified && data === '{"type":"verified-ack"}') {
			this.complete();
		} else {
			await this.current.consume(data);
		}
	}

	complete() {
		this.transfer.callbacks.complete();
		this.transfer.callbacks.send({
			type: 'complete',
			id: this.transfer.transfer.id
		});
	}
}
