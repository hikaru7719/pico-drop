import type { SendChannel } from './ports';
import { describePhotos } from '../photos/index.ts';
import { LIMITS, record, type PhotoMeta } from '../../../../shared/protocol.ts';

const INTERRUPTED = '転送が中断されました。';
const INVALID_DATA = '不正な転送データです。';
const INVALID_ORDER = '受信データの順序・サイズが一致しません。';

export async function digest(data: ArrayBuffer): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
		(b) => b.toString(16).padStart(2, '0')
	).join('');
}

class DrainWaiter {
	private timer: ReturnType<typeof setTimeout>;
	private low = () => this.finish(null);
	private closed = () => this.finish(new Error(INTERRUPTED));

	constructor(
		private channel: SendChannel,
		private signal: AbortSignal,
		private settle: { resolve: () => void; reject: (error: Error) => void }
	) {
		this.timer = setTimeout(() => this.timedOut(), 30_000);
		this.listen();
	}

	private timedOut() {
		this.finish(new Error('送信がタイムアウトしました。'));
	}

	private listen() {
		this.channel.addEventListener('bufferedamountlow', this.low);
		this.channel.addEventListener('close', this.closed);
		this.signal.addEventListener('abort', this.closed, { once: true });
	}

	private finish(error: Error | null) {
		this.cleanup();
		if (error) {
			this.settle.reject(error);
		} else {
			this.settle.resolve();
		}
	}

	private cleanup() {
		clearTimeout(this.timer);
		this.channel.removeEventListener('bufferedamountlow', this.low);
		this.channel.removeEventListener('close', this.closed);
		this.signal.removeEventListener('abort', this.closed);
	}
}

function checkChannel(channel: SendChannel, signal: AbortSignal) {
	if (signal.aborted) {
		throw new Error('中止しました。');
	}
	if (channel.readyState !== 'open') {
		throw new Error('接続が切れました。');
	}
}

async function drain(channel: SendChannel, signal: AbortSignal) {
	checkChannel(channel, signal);
	if (channel.bufferedAmount > 256 * 1024) {
		await new Promise<void>(
			(resolve, reject) => new DrainWaiter(channel, signal, { resolve, reject })
		);
	}
}

export type SendOptions = {
	channel: SendChannel;
	files: File[];
	metadata: PhotoMeta[];
	signal: AbortSignal;
	progress: (bytes: number) => void;
};
class PhotoSender {
	private sent = 0;

	constructor(private options: SendOptions) {}

	async send() {
		const { channel, files, signal } = this.options;
		channel.bufferedAmountLowThreshold = 128 * 1024;
		for (let i = 0; i < files.length; i++) {
			await this.sendFile(files[i], this.options.metadata[i]);
		}
		await drain(channel, signal);
		channel.send(JSON.stringify({ type: 'done' }));
	}

	private async sendFile(file: File, meta: PhotoMeta) {
		const data = await this.readFile(file);
		await this.sendHeader(data, meta.id);
		await this.sendChunks(data);
		this.options.channel.send(
			JSON.stringify({ type: 'file-end', id: meta.id })
		);
	}

	private async readFile(file: File) {
		if (this.options.signal.aborted) {
			throw new Error('中止しました。');
		}
		return file.arrayBuffer();
	}

	private async sendHeader(data: ArrayBuffer, id: string) {
		const sha256 = await digest(data);
		await drain(this.options.channel, this.options.signal);
		this.options.channel.send(JSON.stringify({ type: 'file', id, sha256 }));
	}

	private async sendChunks(data: ArrayBuffer) {
		for (let offset = 0; offset < data.byteLength; offset += LIMITS.chunk) {
			await drain(this.options.channel, this.options.signal);
			const chunk = data.slice(offset, offset + LIMITS.chunk);
			this.options.channel.send(chunk);
			this.sent += chunk.byteLength;
			this.options.progress(this.sent);
		}
	}
}

export async function sendPhotos(options: SendOptions) {
	await new PhotoSender(options).send();
}

function parseMarker(data: unknown) {
	if (typeof data !== 'string' || data.length > 1024) {
		throw new Error(INVALID_DATA);
	}
	const marker: unknown = JSON.parse(data);
	if (!record(marker)) {
		throw new Error(INVALID_DATA);
	}
	return marker;
}

export class PhotoReceiver {
	private index = 0;
	private chunks: ArrayBuffer[] = [];
	private bytes = 0;
	private total = 0;
	private hash = '';
	private active = false;
	private ended = false;

	constructor(
		private metadata: PhotoMeta[],
		private progress: (bytes: number) => void,
		private photo: (file: File) => void,
		private complete: () => void
	) {}

	async consume(data: unknown) {
		if (this.ended) {
			throw new Error('転送は終了しています。');
		}
		if (data instanceof ArrayBuffer) {
			this.receiveChunk(data);
		} else {
			await this.receiveMarker(parseMarker(data));
		}
	}

	private validChunk(data: ArrayBuffer) {
		const meta = this.metadata[this.index];
		return (
			this.active &&
			meta &&
			data.byteLength > 0 &&
			data.byteLength <= LIMITS.chunk &&
			this.bytes + data.byteLength <= meta.size
		);
	}

	private receiveChunk(data: ArrayBuffer) {
		if (!this.validChunk(data)) {
			throw new Error('受信サイズが一致しません。');
		}
		this.chunks.push(data);
		this.bytes += data.byteLength;
		this.total += data.byteLength;
		this.progress(this.total);
	}

	private async receiveMarker(marker: Record<string, unknown>) {
		if (marker.type === 'file') {
			return this.beginFile(marker);
		}
		return this.receiveEndMarker(marker);
	}

	private async receiveEndMarker(marker: Record<string, unknown>) {
		if (marker.type === 'file-end') {
			return this.finishFile(marker);
		}
		if (marker.type === 'done') {
			return this.finish();
		}
		throw new Error(INVALID_ORDER);
	}

	private beginFile(marker: Record<string, unknown>) {
		const meta = this.metadata[this.index];
		const validHash =
			typeof marker.sha256 === 'string' && /^[a-f0-9]{64}$/.test(marker.sha256);
		if (this.active || !meta || marker.id !== meta.id || !validHash) {
			throw new Error(INVALID_ORDER);
		}
		this.active = true;
		this.hash = marker.sha256 as string;
	}

	private endMetadata(marker: Record<string, unknown>) {
		const meta = this.metadata[this.index];
		const valid =
			this.active && meta && marker.id === meta.id && this.bytes === meta.size;
		if (!valid) {
			throw new Error(INVALID_ORDER);
		}
		return meta;
	}

	private async verifyFile(meta: PhotoMeta) {
		const file = new File(this.chunks, meta.name, { type: meta.type });
		await this.verifyHash(file);
		const [detected] = await describePhotos([file]);
		if (detected.type !== meta.type) {
			throw new Error('写真の形式が一致しません。');
		}
		return file;
	}

	private async verifyHash(file: File) {
		if ((await digest(await file.arrayBuffer())) !== this.hash) {
			throw new Error('写真の検証に失敗しました。もう一度送信してください。');
		}
	}

	private async finishFile(marker: Record<string, unknown>) {
		const file = await this.verifyFile(this.endMetadata(marker));
		if (!this.ended) {
			this.acceptFile(file);
		}
	}

	private acceptFile(file: File) {
		this.photo(file);
		this.chunks = [];
		this.bytes = 0;
		this.active = false;
		this.index++;
	}

	private finish() {
		if (this.active || this.index !== this.metadata.length) {
			throw new Error(INVALID_ORDER);
		}
		this.ended = true;
		this.complete();
	}

	dispose() {
		this.ended = true;
		this.chunks = [];
	}
}
