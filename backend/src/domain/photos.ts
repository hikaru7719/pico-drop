import type { PhotoMeta } from '../../../shared/protocol.ts';
import { isHeic, type ConversionMode } from '../../../shared/photos.ts';
export type PhotoGrant = {
	expiresAt: number;
	files: PhotoMeta[];
	uses: Record<string, number>;
};
export function reservePhoto(
	grant: PhotoGrant | undefined,
	id: string,
	mode: string,
	now = Date.now()
) {
	return !grant || grant.expiresAt <= now || !['preview', 'jpeg'].includes(mode)
		? null
		: reserveFile(grant, id, mode as ConversionMode);
}

function reserveFile(grant: PhotoGrant, id: string, mode: ConversionMode) {
	const photo = grant.files.find((file) => file.id === id && isHeic(file.type));
	return photo ? reserveUse(grant, photo, mode) : null;
}

function reserveUse(grant: PhotoGrant, photo: PhotoMeta, mode: ConversionMode) {
	const key = `${photo.id}:${mode}`;
	if ((grant.uses[key] ?? 0) >= 3) {
		return null;
	}
	grant.uses[key] = (grant.uses[key] ?? 0) + 1;
	return { photo, expiresAt: grant.expiresAt };
}
