import assert from 'node:assert/strict';
import { test, vi, afterEach } from 'vitest';
import { reservePhoto, type PhotoGrant } from '../domain/photos.ts';
import { photoRequest } from './images.ts';
import type { PhotoAuthority } from '../application/images.ts';
import { imageRenderer, type ImageService } from '../infrastructure/images.ts';
import { MAX_CONVERSION_BYTES } from '../../../shared/photos.ts';

const heic = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0]);
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

class ConversionFixture {
	calls = 0;
	resizes: unknown[] = [];
	access = grant();
	revoked = false;
	fail = false;
	authority: PhotoAuthority = {
		consumePhoto: async (token, id, mode) => (token === 'secret' ? reservePhoto(this.access, id, mode) : null),
		revokePhoto: async () => {
			this.revoked = true;
		}
	};
	images: ImageService = { input: () => this.input() };

	input() {
		this.calls++;
		return {
			transform: (options: unknown) => this.resize(options),
			output: () => this.output()
		};
	}

	resize(options: unknown) {
		this.resizes.push(options);
		return { output: () => this.output() };
	}

	async output() {
		if (this.fail) {
			throw new Error('Unsupported image');
		}
		return {
			response: () => new Response('JPEG', { headers: { 'Content-Type': 'image/jpeg' } })
		};
	}

	request(body = heic, token = 'secret', mode = 'preview') {
		return new Request(`https://pico.test/api/photos/convert?id=photo&mode=${mode}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body
		});
	}

	run(request = this.request()) {
		return photoRequest(request, imageRenderer(this.images), this.authority);
	}
}

test('unauthorized requests never reach Images', async () => {
	const fixture = new ConversionFixture();
	assert.equal((await fixture.run(fixture.request(heic, 'wrong'))).status, 403);
	assert.equal(fixture.calls, 0);
});

function assertPreview(fixture: ConversionFixture, response: Response) {
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('content-type'), 'image/jpeg');
	assert.deepEqual(fixture.resizes, [{ width: 640, height: 640, fit: 'scale-down' }]);
}

test('preview resizes; download keeps full dimensions', async () => {
	const fixture = new ConversionFixture();
	const response = await fixture.run();
	assertPreview(fixture, response);
	assert.equal(await response.text(), 'JPEG');
	await fixture.run(fixture.request(heic, 'secret', 'jpeg'));
	assert.equal(fixture.resizes.length, 1);
});
for (const [size, status] of [
	[17, 422],
	[15, 422],
	[16, 415]
]) {
	test(`invalid body of ${size} bytes never reaches Images`, async () => {
		const fixture = new ConversionFixture();
		const response = await fixture.run(fixture.request(new Uint8Array(size)));
		assert.equal(response.status, status);
		assert.equal(fixture.calls, 0);
	});
}

test('oversized photos are refused without conversion', async () => {
	const fixture = new ConversionFixture();
	fixture.access.files = [{ ...photo, size: MAX_CONVERSION_BYTES + 1 }];
	assert.equal((await fixture.run()).status, 413);
	assert.equal(fixture.calls, 0);
});
test('Images failures remain uncached', async () => {
	const fixture = new ConversionFixture();
	fixture.fail = true;
	const response = await fixture.run();
	assert.equal(response.status, 422);
	assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('discard revokes the grant', async () => {
	const fixture = new ConversionFixture();
	const request = new Request('https://pico.test/api/photos/discard', {
		method: 'POST'
	});
	assert.equal((await fixture.run(request)).status, 204);
	assert.equal(fixture.revoked, true);
});
test('expiration during image processing refuses output', async () => {
	vi.useFakeTimers({ toFake: ['Date'], now: 10_000 });
	const fixture = new ConversionFixture();
	vi.spyOn(fixture, 'output').mockImplementation(async () => {
		vi.setSystemTime(80_000);
		return { response: () => new Response('JPEG') };
	});
	assert.equal((await fixture.run()).status, 403);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
