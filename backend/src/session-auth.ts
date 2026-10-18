import { readCookie, secretHash } from './auth.ts';
import { authShard } from './routing.ts';

export async function requestLoginKey(request: Request) {
	const token = readCookie(request, 'auth');
	if (!/^(?:v2\.[a-f0-9]{2}\.)?[a-f0-9]{64}$/.test(token)) {
		return '';
	}
	const shard = authShard(token);
	return (
		'auth:login:' + (shard ? `v2.${shard}.` : '') + (await secretHash(token))
	);
}
