import { ReceivedPhotos, releasePhoto, type ReceivedPhoto } from '#lib/photos/received.ts';
import type { sharePhotos as sharePhotoFiles } from '#lib/photos/index.ts';
import type { PhotoAccess, ConversionMode } from '../../../../shared/photos.ts';

type Callbacks = {
	cleared(): void;
	notice(message: string): void;
	error(message: string): void;
};

const shareMessages = {
	shared: '保存・共有の画面を閉じました。写真を保存した場合は、写真アプリなどで確認してください。',
	cancelled: '共有をキャンセルしました。写真はこの画面に残っています。',
	unsupported: 'このブラウザでは写真を共有できません。写真のファイル名を押して、1枚ずつダウンロードしてください。'
};

export class ReceivedPhotoActions {
	items = $state<ReceivedPhoto[]>([]);
	expiresAt = $state<number>();
	sharing = $state(false);
	private collection: ReceivedPhotos | undefined;

	constructor(
		private sharePhotos: typeof sharePhotoFiles,
		private callbacks: Callbacks
	) {}

	get retained() {
		return !!this.collection;
	}

	clear() {
		this.collection?.dispose();
		this.collection = undefined;
		this.expiresAt = undefined;
		for (const photo of this.items) {
			releasePhoto(photo);
		}
		this.items = [];
		this.callbacks.cleared();
	}

	discard() {
		this.clear();
		this.callbacks.error('');
		this.callbacks.notice('画面内の写真を削除しました。端末に保存した写真は残っています。');
	}

	add(file: File, id?: string) {
		const preview = !['image/heic', 'image/heif'].includes(file.type);
		this.items = [...this.items, { file, id, url: URL.createObjectURL(file), preview }];
	}

	retain(access?: PhotoAccess) {
		this.collection = new ReceivedPhotos(this.items, access, {
			changed: (photos) => {
				this.items = photos;
			},
			expired: () => this.expired()
		});
		this.expiresAt = this.collection.expiresAt;
	}

	checkExpiry() {
		return this.collection?.checkExpiry() ?? false;
	}

	private expired() {
		this.expiresAt = undefined;
		this.callbacks.cleared();
		this.callbacks.error('');
		this.callbacks.notice('受信から10分たったため、画面内の写真を削除しました。端末に保存した写真は残っています。');
	}

	async convert(index: number, mode: ConversionMode) {
		await this.collection?.convert(index, mode);
	}

	previewFailed(index: number) {
		const photo = this.items[index];
		if (photo) {
			photo.preview = false;
		}
	}

	async save() {
		if (!this.checkExpiry()) {
			return;
		}
		this.sharing = true;
		this.callbacks.error('');
		await this.tryShare();
	}

	private async tryShare() {
		try {
			await this.shareFiles(this.items.map((photo) => photo.file));
		} catch {
			this.shareFailed('共有できませんでした。各写真のダウンロードをお試しください。');
		} finally {
			this.sharing = false;
		}
	}

	private async shareFiles(files: File[]) {
		const collection = this.collection;
		const result = await this.sharePhotos(files);
		if (collection === this.collection && this.items.length) {
			this.callbacks.notice(shareMessages[result]);
		}
	}

	async shareJpeg(index: number) {
		if (!this.checkExpiry()) {
			return;
		}
		const jpeg = this.items[index]?.jpeg;
		if (jpeg) {
			await this.shareConverted(jpeg);
		}
	}

	private async shareConverted(jpeg: File) {
		try {
			await this.shareFiles([jpeg]);
		} catch {
			this.shareFailed('共有できませんでした。JPEGをダウンロードしてください。');
		}
	}

	private shareFailed(message: string) {
		if (this.items.length) {
			this.callbacks.error(message);
		}
	}
}
