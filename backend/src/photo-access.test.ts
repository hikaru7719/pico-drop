import { test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
	reservePhoto,
	createPhotoAccess,
	consumePhoto,
	revokePhoto,
	grantKey,
	type PhotoGrant
} from './photo-access.ts';
const heic = new Uint8Array([
	0, 0, 0, 16, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0
]);
const photo = {
	id: 'photo',
	name: 'test.heic',
	type: 'image/heic',
	size: heic.length
};
const grant = (): PhotoGrant => ({
	expiresAt: Date.now() + 60_000,
	files: [photo],
	uses: {}
});
test('conversion grants reject expired, absent, wrong photo and invalid mode', () => {
	assert.equal(reservePhoto(undefined, photo.id, 'jpeg'), null);
	assert.equal(reservePhoto(grant(), 'other', 'jpeg'), null);
	assert.equal(reservePhoto(grant(), photo.id, 'other'), null);
	const expired = grant();
	expired.expiresAt = Date.now();
	assert.equal(reservePhoto(expired, photo.id, 'preview'), null);
});
test('conversion quotas are per photo and mode and permit only HEIC', () => {
	const access = grant();
	for (let i = 0; i < 3; i++) {
		assert.ok(reservePhoto(access, photo.id, 'preview'));
	}
	assert.equal(reservePhoto(access, photo.id, 'preview'), null);
	assert.ok(reservePhoto(access, photo.id, 'jpeg'));
	access.files = [{ ...photo, type: 'image/jpeg' }];
	assert.equal(reservePhoto(access, photo.id, 'jpeg'), null);
});

class GrantStore {
	entries = new Map<string, PhotoGrant>();
	get = vi.fn(async (key: string) => structuredClone(this.entries.get(key)));
	put = vi.fn(async (key: string, value: PhotoGrant) => {
		this.entries.set(key, structuredClone(value));
	});
	delete = vi.fn(async (key: string) => this.entries.delete(key));
	storage() {
		return this as unknown as Parameters<typeof createPhotoAccess>[0];
	}
	async create() {
		return createPhotoAccess(this.storage(), [photo], '1234567890abcdef');
	}
	consume(token: string) {
		return consumePhoto(this.storage(), { token, id: photo.id, mode: 'jpeg' });
	}
}
test('grants store only the token hash and persist use counts across reads', async () => {
	const store = new GrantStore();
	const access = await store.create();
	expect(access.token).toMatch(/^1234567890abcdef[a-f0-9]{48}$/);
	const key = await grantKey(access.token);
	expect([...store.entries.keys()]).toEqual([key]);
	await store.consume(access.token);
	await store.consume(access.token);
	expect(store.entries.get(key)?.uses['photo:jpeg']).toBe(2);
});
test('quota exhaustion does not persist a failed reservation', async () => {
	const store = new GrantStore();
	const { token } = await store.create();
	for (let i = 0; i < 3; i++) {
		await store.consume(token);
	}
	expect(await store.consume(token)).toBeNull();
	expect(store.put).toHaveBeenCalledTimes(4);
});
test('revoked and unknown grants are unusable', async () => {
	const store = new GrantStore();
	const { token } = await store.create();
	await revokePhoto(store.storage(), token);
	expect(store.delete).toHaveBeenCalledWith(await grantKey(token));
	expect(await store.consume(token)).toBeNull();
	expect(await store.consume('b'.repeat(64))).toBeNull();
});
test('malformed tokens cannot access storage', async () => {
	const store = new GrantStore();
	expect(await store.consume('invalid')).toBeNull();
	await revokePhoto(store.storage(), 'invalid');
	expect(store.get).not.toHaveBeenCalled();
	expect(store.delete).not.toHaveBeenCalled();
});
