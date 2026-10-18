import { reservePhoto, type PhotoGrant } from '../domain/photos.ts';
import { routedToken } from '../domain/tokens.ts';
import type { PhotoMeta } from '../../../shared/protocol.ts';
import { PHOTO_LIFETIME_MS } from '../../../shared/photos.ts';
import type { PhotoAccess } from '../../../shared/photos.ts';

export interface PhotoStore {
	get(key: string): Promise<PhotoGrant | undefined>;
	put(key: string, grant: PhotoGrant): Promise<void>;
	delete(key: string): Promise<boolean>;
}

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const validToken = (token: string) => /^[a-f0-9]{64}$/.test(token);
export async function grantKey(token: string) {
	const data = new TextEncoder().encode(token);
	return (
		'photo:' + hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
	);
}

export async function createPhotoAccess(
	storage: PhotoStore,
	files: PhotoMeta[],
	room?: string
): Promise<PhotoAccess> {
	const token = routedToken(room);
	const expiresAt = Date.now() + PHOTO_LIFETIME_MS;
	await storage.put(await grantKey(token), { expiresAt, files, uses: {} });
	return { token, expiresAt };
}

type PhotoQuery = { token: string; id: string; mode: string };
export async function consumePhoto(storage: PhotoStore, query: PhotoQuery) {
	if (!validToken(query.token)) {
		return null;
	}
	return consumeStoredPhoto(storage, await grantKey(query.token), query);
}

async function consumeStoredPhoto(
	storage: PhotoStore,
	key: string,
	query: PhotoQuery
) {
	const grant = await storage.get(key);
	const result = reservePhoto(grant, query.id, query.mode);
	await persistGrant(storage, key, result ? grant : undefined);
	return result;
}

export async function revokePhoto(storage: PhotoStore, token: string) {
	if (validToken(token)) {
		await storage.delete(await grantKey(token));
	}
}

async function persistGrant(
	storage: PhotoStore,
	key: string,
	grant?: PhotoGrant
) {
	if (grant) {
		await storage.put(key, grant);
	}
}
