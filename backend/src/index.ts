import {
	clearPreviousChallenge,
	hubFor,
	authRoute,
	requestRate,
	roomRoute
} from './routing.ts';
import { photoRequest } from './images.ts';
import { authJson as json } from './auth.ts';
import type { Bindings } from './bindings.ts';
export { NearbyHub } from './nearby-hub.ts';
const RATE_LIMIT = '認証の試行が多すぎます。しばらく待ってください。';
const SESSION_LIMIT = '接続回数が多すぎます。1分後に再試行してください。';
const API_PATHS = [
	'/api/session',
	'/api/ws',
	'/api/ice',
	'/api/photos/convert',
	'/api/photos/discard'
];
function requestError(request: Request, url: URL) {
	if (request.headers.get('Origin') !== url.origin) {
		return json({ error: 'Origin not allowed' }, 403);
	}
	return API_PATHS.includes(url.pathname) ||
		url.pathname.startsWith('/api/auth/')
		? null
		: json({ error: 'Not found' }, 404);
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api/health') {
			return json({ status: 'ok', service: 'pico-drop-backend' });
		}
		return requestError(request, url) ?? routeRequest(request, env);
	}
} satisfies ExportedHandler<Bindings>;

async function routeRequest(request: Request, env: Bindings) {
	const path = new URL(request.url).pathname;
	if (request.method !== 'POST' && path !== '/api/ws') {
		return json({ error: 'Method not allowed' }, 405);
	}
	return path.startsWith('/api/auth/')
		? routeAuth(request, env)
		: routeSession(request, env);
}
async function routeSession(request: Request, env: Bindings) {
	if (
		new URL(request.url).pathname === '/api/session' &&
		!(await requestRate(env, request, 'session'))
	) {
		return json({ error: SESSION_LIMIT }, 429);
	}
	return routeRoom(request, env);
}

async function routeAuth(request: Request, env: Bindings) {
	if (!(await allowedAuth(request, env))) {
		return json({ error: RATE_LIMIT }, 429);
	}
	await clearPreviousChallenge(env, request);
	const name = authRoute(request);
	const forwarded = new Request(request);
	forwarded.headers.set('X-Auth-Route', name);
	return hubFor(env, name).fetch(forwarded);
}
async function allowedAuth(request: Request, env: Bindings) {
	const path = new URL(request.url).pathname;
	return (
		path.endsWith('/status') ||
		path.endsWith('/logout') ||
		requestRate(env, request, 'auth')
	);
}
function routeRoom(request: Request, env: Bindings) {
	const room = roomRoute(request);
	if (!/^[a-f0-9]{16}$/.test(room)) {
		return json({ error: 'Invalid room' }, 400);
	}
	const hub = hubFor(env, 'room:' + room);
	return forwardRoom(request, env, { room, hub });
}
type RoomDestination = {
	room: string;
	hub: ReturnType<Bindings['HUB']['get']>;
};
function forwardRoom(request: Request, env: Bindings, route: RoomDestination) {
	const url = new URL(request.url);
	url.searchParams.set('room', route.room);
	return url.pathname.startsWith('/api/photos/')
		? photoRequest(request, env.IMAGES, route.hub)
		: route.hub.fetch(new Request(url, request));
}
