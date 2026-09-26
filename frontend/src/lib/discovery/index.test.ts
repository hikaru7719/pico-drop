import { afterEach, expect, test, vi } from 'vitest';
import { locate } from './index.ts';

function geolocation(getCurrentPosition: unknown) {
	vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
}
const options = {
	enableHighAccuracy: false,
	timeout: 15_000,
	maximumAge: 30_000
};
const coords = { latitude: 35, longitude: 139, accuracy: 10 };
afterEach(() => vi.unstubAllGlobals());

test('location returns coordinates without exposing other position fields', async () => {
	const read = vi.fn((resolve) => resolve({ coords, timestamp: 123 }));
	geolocation(read);
	await expect(locate()).resolves.toEqual(coords);
	expect(read).toHaveBeenCalledWith(
		expect.any(Function),
		expect.any(Function),
		options
	);
});
test('location rejects measurements with more than 10 km uncertainty', async () => {
	geolocation((resolve: PositionCallback) =>
		resolve({ coords: { ...coords, accuracy: 10_001 } } as GeolocationPosition)
	);
	await expect(locate()).rejects.toThrow('誤差が大きすぎます');
});
test('location accepts the accuracy boundary', async () => {
	geolocation((resolve: PositionCallback) =>
		resolve({ coords: { ...coords, accuracy: 10_000 } } as GeolocationPosition)
	);
	await expect(locate()).resolves.toEqual({ ...coords, accuracy: 10_000 });
});
test('missing geolocation is reported without starting a request', async () => {
	vi.stubGlobal('navigator', {});
	await expect(locate()).rejects.toThrow('このブラウザでは');
});
test.each([1, 2, 3])(
	'location error %s produces an actionable message',
	async (code) => {
		geolocation((_resolve: PositionCallback, reject: PositionErrorCallback) =>
			reject({ code } as GeolocationPositionError)
		);
		await expect(locate()).rejects.toThrow(
			code === 1 ? '許可されていません' : '取得できませんでした'
		);
	}
);
