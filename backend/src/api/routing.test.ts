import { test, expect } from 'vitest';
import { routedToken, sessionLoginKey } from '../domain/tokens.ts';
import { roomRoute } from './routing.ts';

const request = (path: string, headers = {}) => new Request('https://photos.example' + path, { headers });

test('independent sessions get different rooms; invitations and sockets retain their room', () => {
	const room = roomRoute(request('/api/session'));
	expect(roomRoute(request('/api/session'))).not.toBe(room);
	expect(roomRoute(request('/api/session?room=' + room))).toBe(room);
	expect(roomRoute(request('/api/ws?room=' + room))).toBe(room);
});
for (const path of ['/api/ice', '/api/photos/convert', '/api/photos/discard']) {
	test(path + ' returns to the token issuer without a central registry', () => {
		const room = '1234567890abcdef';
		const token = routedToken(room);
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		expect(roomRoute(request(path, { Authorization: 'Bearer ' + token }))).toBe(room);
	});
}

test('old sharded login cookies are invalidated and new secrets are hashed', async () => {
	const secret = 'a'.repeat(64);
	expect(await sessionLoginKey('v2.ab.' + secret)).toBe('');
	expect(await sessionLoginKey('invalid')).toBe('');
	const key = await sessionLoginKey(secret);
	expect(key).toMatch(/^auth:login:[a-f0-9]{64}$/);
	expect(key).not.toContain(secret);
});

test('missing room credentials remain invalid', () => {
	expect(roomRoute(request('/api/ws'))).toBe('');
	expect(roomRoute(request('/api/ice'))).toBe('');
	expect(roomRoute(request('/api/ice', { Authorization: 'invalid' }))).toBe('');
	expect(routedToken(undefined)).toMatch(/^[a-f0-9]{64}$/);
});
