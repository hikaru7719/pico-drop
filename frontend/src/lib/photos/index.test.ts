import { test, vi, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { describePhotos, formatBytes, sharePhotos } from './index.ts';
const data = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]).buffer;
test('photo classification uses file bytes', async () => {
	const [jpeg] = await describePhotos([
		new File([data], 'camera.heic', { type: 'image/heic' })
	]);
	assert.equal(jpeg.type, 'image/jpeg');
});
test('photo classification rejects renamed non-photos', async () => {
	const fake = new File(['not a photo'], 'fake.jpg', { type: 'image/jpeg' });
	await assert.rejects(describePhotos([fake]));
});
test('photo classification preserves HEIC', async () => {
	const heic = new Uint8Array(24);
	heic.set(new TextEncoder().encode('ftypheic'), 4);
	const [photo] = await describePhotos([
		new File([heic], 'camera.heic', { type: 'image/heic' })
	]);
	assert.equal(photo.type, 'image/heic');
	assert.equal(photo.name, 'camera.heic');
});

function mockShare(canShare: boolean, share: () => Promise<void>) {
	vi.stubGlobal('navigator', { canShare: () => canShare, share });
}

const shareFiles = [new File([data], 'photo.jpg', { type: 'image/jpeg' })];
test('share cancellation and completion remain distinct from confirmed photo-library saving', async () => {
	mockShare(true, async () => {
		throw new DOMException('Cancelled', 'AbortError');
	});
	assert.equal(await sharePhotos(shareFiles), 'cancelled');
	mockShare(true, async () => {});
	assert.equal(await sharePhotos(shareFiles), 'shared');
	mockShare(false, async () => {});
	assert.equal(await sharePhotos(shareFiles), 'unsupported');
});
test('byte labels retain precision for small photos and zero progress', () => {
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(7), '7 B');
	assert.equal(formatBytes(15), '15 B');
	assert.equal(formatBytes(1024), '1 KB');
	assert.equal(formatBytes(1024 * 1024), '1.0 MB');
});

afterEach(() => vi.unstubAllGlobals());
