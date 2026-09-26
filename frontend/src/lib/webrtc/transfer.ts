import { describePhotos } from '../photos/index.ts';
import { LIMITS, record, type PhotoMeta } from '../../../../shared/protocol.ts';

export async function digest(data: ArrayBuffer): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
		(b) => b.toString(16).padStart(2, '0')
	).join('');
}
function drain(channel: RTCDataChannel, signal: AbortSignal) {
	if (signal.aborted) return Promise.reject(new Error('中止しました。'));
	if (channel.readyState !== 'open')
		return Promise.reject(new Error('接続が切れました。'));
	if (channel.bufferedAmount <= 256 * 1024) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const finish = (error?: Error) => {
			clearTimeout(timer);
			channel.removeEventListener('bufferedamountlow', low);
			channel.removeEventListener('close', closed);
			signal.removeEventListener('abort', closed);
			if (error) reject(error);
			else resolve();
		};
		const low = () => finish();
		const closed = () => finish(new Error('転送が中断されました。'));
		const timer = setTimeout(
			() => finish(new Error('送信がタイムアウトしました。')),
			30_000
		);
		channel.addEventListener('bufferedamountlow', low);
		channel.addEventListener('close', closed);
		signal.addEventListener('abort', closed, { once: true });
	});
}
export async function sendPhotos(
	channel: RTCDataChannel,
	files: File[],
	metadata: PhotoMeta[],
	signal: AbortSignal,
	progress: (bytes: number) => void
) {
	channel.bufferedAmountLowThreshold = 128 * 1024;
	let sent = 0;
	for (let i = 0; i < files.length; i++) {
		if (signal.aborted) throw new Error('中止しました。');
		// One bounded file at a time; bytes are never sent through HTTP or WebSocket.
		const data = await files[i].arrayBuffer();
		const sha256 = await digest(data);
		await drain(channel, signal);
		channel.send(JSON.stringify({ type: 'file', id: metadata[i].id, sha256 }));
		for (let offset = 0; offset < data.byteLength; offset += LIMITS.chunk) {
			await drain(channel, signal);
			const chunk = data.slice(offset, offset + LIMITS.chunk);
			channel.send(chunk);
			sent += chunk.byteLength;
			progress(sent);
		}
		channel.send(JSON.stringify({ type: 'file-end', id: metadata[i].id }));
	}
	await drain(channel, signal);
	channel.send(JSON.stringify({ type: 'done' }));
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
		if (this.ended) throw new Error('転送は終了しています。');
		const meta = this.metadata[this.index];
		if (data instanceof ArrayBuffer) {
			if (
				!this.active ||
				!meta ||
				data.byteLength === 0 ||
				data.byteLength > LIMITS.chunk ||
				this.bytes + data.byteLength > meta.size
			)
				throw new Error('受信サイズが一致しません。');
			this.chunks.push(data);
			this.bytes += data.byteLength;
			this.total += data.byteLength;
			this.progress(this.total);
			return;
		}
		if (typeof data !== 'string' || data.length > 1024)
			throw new Error('不正な転送データです。');
		const m: unknown = JSON.parse(data);
		if (!record(m)) throw new Error('不正な転送データです。');
		if (
			m.type === 'file' &&
			!this.active &&
			meta &&
			m.id === meta.id &&
			typeof m.sha256 === 'string' &&
			/^[a-f0-9]{64}$/.test(m.sha256)
		) {
			this.active = true;
			this.hash = m.sha256;
			return;
		}
		if (
			m.type === 'file-end' &&
			this.active &&
			meta &&
			m.id === meta.id &&
			this.bytes === meta.size
		) {
			const file = new File(this.chunks, meta.name, { type: meta.type });
			if ((await digest(await file.arrayBuffer())) !== this.hash)
				throw new Error('写真の検証に失敗しました。もう一度送信してください。');
			const [detected] = await describePhotos([file]);
			if (detected.type !== meta.type)
				throw new Error('写真の形式が一致しません。');
			if (this.ended) return;
			this.photo(file);
			this.chunks = [];
			this.bytes = 0;
			this.active = false;
			this.index++;
			return;
		}
		if (
			m.type === 'done' &&
			!this.active &&
			this.index === this.metadata.length
		) {
			this.ended = true;
			this.complete();
			return;
		}
		throw new Error('受信データの順序・サイズが一致しません。');
	}
	dispose() {
		this.ended = true;
		this.chunks = [];
	}
}
