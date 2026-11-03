import { test, expect, vi, afterEach } from 'vitest';
import { iceServers } from './turn.ts';

afterEach(() => vi.unstubAllGlobals());
test.each([{}, { TURN_KEY_ID: 'key' }, { TURN_KEY_API_TOKEN: 'secret' }])(
	'missing TURN config falls back to STUN',
	async (env) => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		expect(await iceServers(env)).toEqual({
			iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
			relay: false
		});
		expect(fetch).not.toHaveBeenCalled();
	}
);
const config = { TURN_KEY_ID: 'key/id', TURN_KEY_API_TOKEN: 'private' };
test('TURN adapter requests short-lived credentials and returns only ICE servers', async () => {
	const fetch = turnFetch();
	vi.stubGlobal('fetch', fetch);
	expect(await iceServers(config)).toEqual({
		iceServers: turnServers,
		relay: true
	});
	expect(fetch.mock.calls[0][0]).toContain('/key%2Fid/');
	expect(fetch.mock.calls[0][1]).toMatchObject(turnRequest);
});
test('failed TURN requests are reported to the application service', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
	await expect(iceServers(config)).rejects.toThrow('TURN');
});

const turnServers = [{ urls: 'turn:example', username: 'user', credential: 'short-lived' }];
const turnRequest = {
	method: 'POST',
	body: '{"ttl":900}',
	headers: { Authorization: 'Bearer private' }
};

function turnFetch() {
	return vi.fn().mockResolvedValue(Response.json({ iceServers: turnServers }));
}
