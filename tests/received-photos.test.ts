import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
	ReceivedPhotos,
	type ReceivedPhoto
} from '../frontend/src/lib/photos/received.ts';
import { PHOTO_LIFETIME_MS } from '../shared/photos.ts';

const photoAccess = () => ({
	token: 'secret',
	expiresAt: Date.now() + PHOTO_LIFETIME_MS
});
class PhotosFixture {
	photos: ReceivedPhoto[] = [];
	expired = false;
	requests: { url: string; options?: RequestInit }[] = [];
	revoked: string[] = [];
	result: Promise<Response> = Promise.resolve(new Response('JPEG'));
	collection: ReceivedPhotos;
	constructor(t: TestContext) {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
		this.mockIO(t);
		this.photos = [this.original()];
		const access = photoAccess();
		this.collection = new ReceivedPhotos(this.photos, access, this.callbacks());
		t.after(() => this.collection.dispose());
	}

	original(): ReceivedPhoto {
		return {
			id: 'photo',
			file: new File(['HEIC'], 'photo.heic', { type: 'image/heic' }),
			url: 'blob:original',
			preview: false
		};
	}

	callbacks() {
		return {
			changed: (photos: ReceivedPhoto[]) => {
				this.photos = photos;
			},
			expired: () => {
				this.expired = true;
			}
		};
	}

	mockIO(t: TestContext) {
		t.mock.method(URL, 'revokeObjectURL', (url: string) =>
			this.revoked.push(url)
		);
		t.mock.method(URL, 'createObjectURL', () => 'blob:derived');
		t.mock.method(globalThis, 'fetch', (url: string, options?: RequestInit) =>
			this.fetch(url, options)
		);
	}

	fetch(url: string, options?: RequestInit) {
		this.requests.push({ url, options });
		return url.includes('discard')
			? Promise.resolve(new Response(null, { status: 204 }))
			: this.result;
	}
}

await test('JPEG conversion preserves the original and caches the result only in memory', async (t) => {
	const fixture = new PhotosFixture(t);
	const original = fixture.photos[0].file;
	await fixture.collection.convert(0, 'jpeg');
	assert.equal(fixture.photos[0].file, original);
	assert.equal(fixture.photos[0].jpeg?.name, 'photo.jpg');
	assertRequest(fixture, original);
	await fixture.collection.convert(0, 'jpeg');
	assert.equal(fixture.requests.length, 1);
});
await test('expiry clears originals and derivatives and revokes conversion access', async (t) => {
	const fixture = new PhotosFixture(t);
	await fixture.collection.convert(0, 'preview');
	t.mock.timers.tick(PHOTO_LIFETIME_MS);
	assert.equal(fixture.expired, true);
	assert.deepEqual(fixture.photos, []);
	assert.deepEqual(fixture.revoked, ['blob:original', 'blob:derived']);
	assert.ok(fixture.requests.at(-1)?.url.includes('discard'));
});
await test('resume after a suspended timer checks the absolute deadline', (t) => {
	const fixture = new PhotosFixture(t);
	t.mock.timers.setTime(Date.now() + PHOTO_LIFETIME_MS);
	assert.equal(fixture.collection.checkExpiry(), false);
	assert.equal(fixture.photos.length, 0);
});
await test('a failed conversion retains the original for download', async (t) => {
	const fixture = new PhotosFixture(t);
	fixture.result = Promise.resolve(
		new Response('Unavailable', { status: 503 })
	);
	await fixture.collection.convert(0, 'jpeg');
	assert.equal(fixture.photos[0].url, 'blob:original');
	assert.ok(fixture.photos[0].problem);
	assert.equal(fixture.photos[0].busy, false);
});
await test('discard aborts conversion and late responses cannot restore photos', async (t) => {
	const fixture = new PhotosFixture(t);
	const resolve = pendingResponse(fixture);
	const pending = fixture.collection.convert(0, 'preview');
	fixture.collection.dispose();
	resolve();
	await pending;
	assert.equal(fixture.requests[0].options?.signal?.aborted, true);
	assertDiscarded(fixture);
});

function assertRequest(fixture: PhotosFixture, original: File) {
	assert.equal(fixture.requests[0].options?.body, original);
	assert.equal(fixture.requests[0].options?.cache, 'no-store');
}

function pendingResponse(fixture: PhotosFixture) {
	let resolve!: (response: Response) => void;
	fixture.result = new Promise((done) => {
		resolve = done;
	});
	return () => resolve(new Response('JPEG'));
}

function assertDiscarded(fixture: PhotosFixture) {
	assert.deepEqual(fixture.photos, []);
	assert.deepEqual(fixture.revoked, ['blob:original']);
}
