/* eslint-disable no-control-regex -- Reject or sanitize control characters in photo names. */
import { LIMITS, validPhotos, type PhotoMeta } from '../../../../shared/protocol.ts';

const PHOTO_ERROR = 'JPEG・PNG・WebP・HEIC/HEIFの写真を選んでください。';

const decode = (bytes: Uint8Array, start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));

const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

const isPng = (b: Uint8Array) => [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);

const isWebp = (b: Uint8Array) => decode(b, 0, 4) === 'RIFF' && decode(b, 8, 12) === 'WEBP';

function heifType(b: Uint8Array, type: string) {
	if (decode(b, 4, 8) !== 'ftyp') {
		return '';
	}
	return heifBrand(decode(b, 8, 12), type);
}

function heifBrand(brand: string, type: string) {
	if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) {
		return 'image/heic';
	}
	return ['mif1', 'msf1'].includes(brand) && ['image/heic', 'image/heif'].includes(type) ? type : '';
}

function photoType(b: Uint8Array, type: string) {
	if (isJpeg(b)) {
		return 'image/jpeg';
	}
	if (isPng(b)) {
		return 'image/png';
	}
	return isWebp(b) ? 'image/webp' : heifType(b, type);
}

function photoMetadata(file: File, type: string): PhotoMeta {
	return {
		id: crypto.randomUUID(),
		name: file.name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 100) || 'photo',
		size: file.size,
		type
	};
}

async function describePhoto(file: File) {
	const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
	const type = photoType(bytes, file.type);
	if (!type) {
		throw new Error(`${file.name}: ${PHOTO_ERROR}`);
	}
	return photoMetadata(file, type);
}

function checkPhotoLimits(files: File[]) {
	const total = files.reduce((n, f) => n + f.size, 0);
	if (!files.length || files.length > LIMITS.files || total > LIMITS.bytes) {
		throw new Error('写真は10枚・合計50MBまで選べます。');
	}
}

export async function describePhotos(files: File[]): Promise<PhotoMeta[]> {
	checkPhotoLimits(files);
	const metadata = await Promise.all(files.map(describePhoto));
	if (!validPhotos(metadata)) {
		throw new Error('写真の形式・容量を確認してください。');
	}
	return metadata;
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export async function sharePhotos(files: File[]) {
	if (!navigator.canShare?.({ files })) {
		return 'unsupported' as const;
	}
	return shareSupported(files);
}

async function shareSupported(files: File[]) {
	try {
		await navigator.share({ files });
		return 'shared' as const;
	} catch (e) {
		return shareFailure(e);
	}
}

function shareFailure(e: unknown) {
	if (e instanceof Error && e.name === 'AbortError') {
		return 'cancelled' as const;
	}
	throw e;
}
