import { randomSecret } from '../domain/tokens.ts';
import { authName } from '../domain/tokens.ts';
import { readCookie } from './http.ts';

export function authRoute(request: Request) {
	const action = new URL(request.url).pathname.split('/').at(-1);
	if (action === 'options') {
		return 'auth:' + randomSecret().slice(0, 2);
	}
	const kind = action === 'verify' ? 'challenge' : 'auth';
	const token = readCookie(request, kind);
	return token ? authName(token) : 'auth:' + randomSecret().slice(0, 2);
}

export function roomRoute(request: Request) {
	const url = new URL(request.url);
	if (url.pathname === '/api/session') {
		return url.searchParams.get('room') ?? randomSecret().slice(0, 16);
	}
	if (url.pathname === '/api/ws') {
		return url.searchParams.get('room') ?? '';
	}
	return bearerRoom(request);
}

function bearerRoom(request: Request) {
	const token =
		request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
	return /^[a-f0-9]{64}$/.test(token) ? token.slice(0, 16) : '';
}
