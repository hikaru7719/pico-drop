import { test } from 'vitest';
import assert from 'node:assert/strict';
import { reservePhoto, type PhotoGrant } from './photo-access.ts';
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
