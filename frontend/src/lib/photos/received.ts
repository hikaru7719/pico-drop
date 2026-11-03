import { api } from '../api';
import { MAX_CONVERSION_BYTES, PHOTO_LIFETIME_MS, isHeic } from '../../../../shared/photos.ts';
import type { ConversionMode, PhotoAccess } from '../../../../shared/photos.ts';

export type ReceivedPhoto = {
	file: File;
	url: string;
	preview: boolean;
	id?: string;
	previewUrl?: string;
	jpeg?: File;
	jpegUrl?: string;
	busy?: boolean;
	problem?: string;
};

type Conversion = { photo: ReceivedPhoto; index: number; mode: ConversionMode };

type Callbacks = {
	changed: (photos: ReceivedPhoto[]) => void;
	expired: () => void;
};

const FAILED = '変換できませんでした。元の写真は保存できます。';
const TOO_LARGE = '変換は1枚20MiBまでです。元の写真を保存してください。';
const NO_ACCESS = 'この写真を変換できません。元の写真を保存してください。';

const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });

export function releasePhoto(photo: ReceivedPhoto) {
	for (const url of [photo.url, photo.previewUrl, photo.jpegUrl]) {
		if (url) {
			URL.revokeObjectURL(url);
		}
	}
}

function revokeAccess(token: string) {
	void api.photos.discard
		.$post(undefined, {
			headers: authorization(token),
			init: { keepalive: true }
		})
		.catch(() => {});
}

function conversionProblem(photo: ReceivedPhoto, access?: PhotoAccess) {
	return photo.file.size > MAX_CONVERSION_BYTES ? TOO_LARGE : !access ? NO_ACCESS : '';
}

function jpegResult(blob: Blob, photo: ReceivedPhoto) {
	const jpeg = new File([blob], jpegName(photo.file.name), {
		type: 'image/jpeg'
	});
	return { jpeg, jpegUrl: URL.createObjectURL(jpeg) };
}

function conversionResult(blob: Blob, job: Conversion) {
	return job.mode === 'preview' ? { previewUrl: URL.createObjectURL(blob), preview: true } : jpegResult(blob, job.photo);
}

export class ReceivedPhotos {
	private abort = new AbortController();
	private timer: ReturnType<typeof setTimeout>;
	private closed = false;
	readonly expiresAt: number;

	constructor(
		private photos: ReceivedPhoto[],
		private access: PhotoAccess | undefined,
		private callbacks: Callbacks
	) {
		this.expiresAt = access?.expiresAt ?? Date.now() + PHOTO_LIFETIME_MS;
		this.timer = this.expiryTimer();
	}

	private expiryTimer() {
		return setTimeout(() => this.checkExpiry(), Math.max(0, this.expiresAt - Date.now()));
	}

	checkExpiry() {
		if (this.closed) {
			return false;
		}
		return Date.now() < this.expiresAt || this.expire();
	}

	private expire() {
		this.dispose();
		this.callbacks.expired();
		return false;
	}

	dispose() {
		if (this.closed) {
			return;
		}
		this.closed = true;
		clearTimeout(this.timer);
		this.abort.abort();
		this.clearPhotos();
	}

	private clearPhotos() {
		this.photos.forEach(releasePhoto);
		this.photos = [];
		this.callbacks.changed([]);
		if (this.access) {
			revokeAccess(this.access.token);
		}
		this.access = undefined;
	}

	private update(index: number, values: Partial<ReceivedPhoto>) {
		if (!this.checkExpiry()) {
			return;
		}
		this.publish(index, values);
	}

	private publish(index: number, values: Partial<ReceivedPhoto>) {
		this.photos = this.photos.map((photo, i) => (i === index ? { ...photo, ...values } : photo));
		this.callbacks.changed(this.photos);
	}

	async convert(index: number, mode: ConversionMode) {
		if (!this.checkExpiry()) {
			return;
		}
		const photo = this.photos[index];
		if (this.available(photo, mode)) {
			await this.startConversion({ photo, index, mode });
		}
	}

	private available(photo: ReceivedPhoto, mode: ConversionMode) {
		return photo && !photo.busy && isHeic(photo.file.type) && !(mode === 'jpeg' ? photo.jpegUrl : photo.previewUrl);
	}

	private async startConversion(job: Conversion) {
		const problem = conversionProblem(job.photo, this.access);
		if (problem) {
			this.update(job.index, { problem });
			return;
		}
		this.update(job.index, { busy: true, problem: '' });
		await this.runConversion(job);
	}

	private async runConversion(job: Conversion) {
		try {
			await this.fetchConversion(job);
		} catch (e) {
			this.failed(job.index, e);
		} finally {
			this.update(job.index, { busy: false });
		}
	}

	private failed(index: number, e: unknown) {
		this.update(index, { problem: e instanceof Error ? e.message : FAILED });
	}

	private requestOptions(file: File): RequestInit {
		return {
			headers: authorization(this.access!.token),
			body: file,
			signal: this.abort.signal,
			cache: 'no-store'
		};
	}

	private async fetchConversion(job: Conversion) {
		const response = await api.photos.convert.$post(
			{ query: { id: job.photo.id!, mode: job.mode } },
			{ init: this.requestOptions(job.photo.file) }
		);
		if (!response.ok) {
			throw new Error(FAILED);
		}
		this.keepResult(await response.blob(), job);
	}

	private keepResult(blob: Blob, job: Conversion) {
		if (!this.checkExpiry()) {
			return;
		}
		this.publish(job.index, conversionResult(blob, job));
	}
}

export function jpegName(name: string) {
	return name.replace(/\.[^.]+$/, '') + '.jpg';
}
