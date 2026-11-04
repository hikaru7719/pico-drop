import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { sharePhotos } from '../photos/index.ts';
import { ReceivedPhotoActions } from './received-photos.svelte.ts';

const collections: ReceivedPhotoActions[] = [];
const photo = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });
const revoked = vi.fn<(url: string) => void>();

beforeEach(() => {
	let id = 0;
	vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:photo-' + id++);
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoked);
});

afterEach(() => {
	collections.splice(0).forEach((photos) => photos.clear());
	vi.restoreAllMocks();
	revoked.mockClear();
});

function fixture() {
	const share = vi.fn<typeof sharePhotos>().mockResolvedValue('shared');
	const callbacks = { cleared: vi.fn(), notice: vi.fn(), error: vi.fn() };
	const photos = new ReceivedPhotoActions(share, callbacks);
	collections.push(photos);
	return { photos, share, callbacks };
}

function receive(photos: ReceivedPhotoActions) {
	photos.add(photo, 'photo');
	photos.retain();
}

test('clearing one received collection releases its URLs once and preserves other collections', () => {
	const first = fixture();
	const second = fixture();
	receive(first.photos);
	receive(second.photos);
	first.photos.clear();
	expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:photo-0');
	expect(first.photos.items).toEqual([]);
	expect(second.photos.items).toHaveLength(1);
});

function pendingSave() {
	const app = fixture();
	const pending = Promise.withResolvers<'shared'>();
	app.share.mockReturnValueOnce(pending.promise);
	receive(app.photos);
	return { ...app, pending, saving: app.photos.save() };
}

test('sharing a replaced collection cannot publish a notice into the new collection', async () => {
	const { photos, callbacks, pending, saving } = pendingSave();
	photos.clear();
	receive(photos);
	pending.resolve('shared');
	await saving;
	expect(callbacks.notice).not.toHaveBeenCalled();
	expect(photos.items).toHaveLength(1);
});
