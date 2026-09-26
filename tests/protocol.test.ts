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
test('only receiver can accept; no signaling or completion before acceptance', () => {
	const t = transfer();
	assert.throws(() => authorizeTransfer(t, 'a', 'accept'));
	assert.throws(() => authorizeTransfer(t, 'c', 'cancel'));
	assert.throws(() => authorizeTransfer(t, 'a', 'signal'));
	assert.throws(() => authorizeTransfer(t, 'b', 'complete'));
	authorizeTransfer(t, 'b', 'accept');

	t.started = true;
	authorizeTransfer(t, 'a', 'signal');
	authorizeTransfer(t, 'b', 'complete');
	assert.throws(() => authorizeTransfer(t, 'a', 'complete'));
	assert.throws(() => authorizeTransfer(t, 'b', 'accept'));
	t.expiresAt = Date.now() - 1;
	assert.throws(() => authorizeTransfer(t, 'a', 'signal'));
});
test('photo limits, MIME allowlist, unique IDs and safe names', () => {
	assert.equal(validPhotos([photo]), true);
	for (const files of [
		[],
		Array(11).fill(photo),
		[photo, photo],
		[{ ...photo, type: 'text/html' }],
		[{ ...photo, size: LIMITS.bytes + 1 }],
		[{ ...photo, size: -1 }],
		[{ ...photo, name: '../x.jpg' }]
	])
		assert.equal(validPhotos(files), false);
});
test('signaling validation rejects malformed messages and coordinates', () => {
	for (const input of [
		null,
		{
			type: 'presence',
			location: { latitude: 91, longitude: 0, accuracy: 10 }
		},
		{
			type: 'presence',
			location: { latitude: 0, longitude: 0, accuracy: Infinity }
		},
		{ type: 'request', to: 'b', files: [] },
		{ type: 'signal', id: 't', signal: { candidate: { candidate: 123 } } }
	])
		assert.throws(() => parseClient(input));
	assert.equal(
		parseClient({ type: 'presence', location: null }).type,
		'presence'
	);
});
test('nearby works across longitude boundary without returning coordinates', () => {
	assert.equal(
		nearby(
			{ latitude: 0, longitude: 179.999, accuracy: 10 },
			{ latitude: 0, longitude: -179.999, accuracy: 10 }
		),
		true
	);
	assert.equal(
		nearby(
			{ latitude: 35, longitude: 139, accuracy: 10 },
			{ latitude: 36, longitude: 140, accuracy: 10 }
		),
		false
	);
});
