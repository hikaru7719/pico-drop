/* eslint-disable no-control-regex -- Reject or sanitize control characters in photo names. */
import {
	LIMITS,
	validPhotos,
	type PhotoMeta
} from '../../../../shared/protocol.ts';

export async function describePhotos(files: File[]): Promise<PhotoMeta[]> {
	if (
		!files.length ||
		files.length > LIMITS.files ||
		files.reduce((n, f) => n + f.size, 0) > LIMITS.bytes
	)
		throw new Error('写真は10枚・合計50MBまで選べます。');
	const metadata = await Promise.all(
		files.map(async (file) => {
			const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
			let type = '';
			if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) type = 'image/jpeg';
			else if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v))
				type = 'image/png';
			else if (
				new TextDecoder().decode(b.slice(0, 4)) === 'RIFF' &&
				new TextDecoder().decode(b.slice(8, 12)) === 'WEBP'
			)
				type = 'image/webp';
			else if (new TextDecoder().decode(b.slice(4, 8)) === 'ftyp') {
				const brand = new TextDecoder().decode(b.slice(8, 12));
				if (['heic', 'heix', 'hevc', 'hevx'].includes(brand))
					type = 'image/heic';
				else if (
					['mif1', 'msf1'].includes(brand) &&
					['image/heic', 'image/heif'].includes(file.type)
				)
					type = file.type;
			}
			if (!type)
				throw new Error(
					`${file.name}: JPEG・PNG・WebP・HEIC/HEIFの写真を選んでください。`
				);
			return {
				id: crypto.randomUUID(),
				name:
					file.name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 100) || 'photo',
				size: file.size,
				type
			};
		})
	);
	if (!validPhotos(metadata))
		throw new Error('写真の形式・容量を確認してください。');
	return metadata;
}
export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	return bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.ceil(bytes / 1024)} KB`;
}
export async function sharePhotos(files: File[]) {
	if (!navigator.canShare?.({ files })) return 'unsupported';
	try {
		await navigator.share({ files });
		return 'shared';
	} catch (e) {
		if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
		throw e;
	}
}
