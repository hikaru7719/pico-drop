const deniedActions = [
	['a', 'accept'],
	['c', 'cancel'],
	['a', 'signal'],
	['b', 'complete']
];
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	authorizeTransfer,
	parseClient,
	validPhotos,
	nearby,
	LIMITS,
	type TransferState
} from '../shared/protocol.ts';
const photo = {
	id: 'photo-1',
	name: 'photo.jpg',
	type: 'image/jpeg',
	size: 10
};
function transfer(): TransferState {
	return {
		id: 't',
		from: { id: 'a', name: 'A' },
		to: { id: 'b', name: 'B' },
		files: [photo],
		started: false,
		expiresAt: Date.now() + 60_000
	};
}

void test('only receiver can accept; no signaling or completion before acceptance', () => {
	const t = transfer();
	for (const [actor, action] of deniedActions) {
		assert.throws(() => authorizeTransfer(t, actor, action));
	}
	authorizeTransfer(t, 'b', 'accept');
});
void test('accepted transfers restrict completion and duplicate approval', () => {
	const t = { ...transfer(), started: true };
	authorizeTransfer(t, 'a', 'signal');
	authorizeTransfer(t, 'b', 'complete');
	assert.throws(() => authorizeTransfer(t, 'a', 'complete'));
	assert.throws(() => authorizeTransfer(t, 'b', 'accept'));
	t.expiresAt = Date.now() - 1;
	assert.throws(() => authorizeTransfer(t, 'a', 'signal'));
});
const sparsePhotos: unknown[] = [];
sparsePhotos.length = 1;
const invalidPhotos = [
	[],
	sparsePhotos,
	Array(11).fill(photo),
	[photo, photo],
	[{ ...photo, type: 'text/html' }],
	[{ ...photo, size: LIMITS.bytes + 1 }],
	[{ ...photo, size: -1 }],
	[{ ...photo, name: '../x.jpg' }]
];
void test('photo limits, MIME allowlist, unique IDs and safe names', () => {
	assert.equal(validPhotos([photo]), true);
	for (const files of invalidPhotos) {
		assert.equal(validPhotos(files), false);
	}
});
const invalidMessages = [
	null,
	{ type: 'presence', location: { latitude: 91, longitude: 0, accuracy: 10 } },
	{
		type: 'presence',
		location: { latitude: 0, longitude: 0, accuracy: Infinity }
	},
	{ type: 'request', to: 'b', files: [] },
	{ type: 'signal', id: 't', signal: { candidate: { candidate: 123 } } }
];
void test('signaling validation rejects malformed messages and coordinates', () => {
	for (const input of invalidMessages) {
		assert.throws(() => parseClient(input));
	}
	assert.equal(
		parseClient({ type: 'presence', location: null }).type,
		'presence'
	);
});
const location = (latitude: number, longitude: number) => ({
	latitude,
	longitude,
	accuracy: 10
});
void test('nearby works across longitude boundary without returning coordinates', () => {
	assert.equal(nearby(location(0, 179.999), location(0, -179.999)), true);
	assert.equal(nearby(location(35, 139), location(36, 140)), false);
});
