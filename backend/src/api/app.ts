import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { authJson, readCookie } from './http.ts';
import { authRoute, roomRoute } from './routing.ts';
import { photoRequest } from './images.ts';
import type { ImageRenderer, PhotoAuthority } from '../application/images.ts';
import { serviceError } from './errors.ts';
export interface HubDestination extends PhotoAuthority {
	fetch(request: Request): Promise<Response>;
}
export interface ApiGateway {
	hub(name: string): HubDestination;
	rate(ip: string, kind: string): Promise<boolean>;
	clearChallenge(token: string): Promise<void>;
	images: ImageRenderer;
}
type ApiEnv<Bindings extends object> = {
	Bindings: Bindings;
	Variables: { gateway: ApiGateway };
};
type ApiContext<Bindings extends object> = Context<ApiEnv<Bindings>>;
const SESSION_LIMIT = '接続回数が多すぎます。1分後に再試行してください。';
const AUTH_LIMIT = '認証の試行が多すぎます。しばらく待ってください。';

export function createApp<Bindings extends object>(
	gateway: (env: Bindings) => ApiGateway
) {
	const app = new Hono<ApiEnv<Bindings>>();
	configure(app, gateway);
	routes(app);
	app.notFound(() => authJson({ error: 'Not found' }, 404));
	app.onError(serviceError);
	return app;
}

function configure<B extends object>(
	app: Hono<ApiEnv<B>>,
	gateway: (env: B) => ApiGateway
) {
	app.all('/api/health', () =>
		authJson({ status: 'ok', service: 'pico-drop-backend' })
	);
	app.use('*', sameOrigin);
	dependencies(app, gateway);
}

function dependencies<B extends object>(
	app: Hono<ApiEnv<B>>,
	gateway: (env: B) => ApiGateway
) {
	app.use('*', async (c, next) => {
		c.set('gateway', gateway(c.env));
		await next();
	});
}

function routes<B extends object>(app: Hono<ApiEnv<B>>) {
	app.all('/api/auth', () => authJson({ error: 'Not found' }, 404));
	app.post('/api/auth/*', (c) => routeAuth(c));
	app.all('/api/auth/*', methodError);
	for (const path of SESSION_PATHS) {
		app.post(path, (c) => routeSession(c));
		app.all(path, methodError);
	}
	app.all('/api/ws', (c) => routeRoom(c));
}

const SESSION_PATHS = [
	'/api/session',
	'/api/ice',
	'/api/photos/convert',
	'/api/photos/discard'
];

const methodError = () => authJson({ error: 'Method not allowed' }, 405);

async function routeAuth<Bindings extends object>(c: ApiContext<Bindings>) {
	const gateway = c.get('gateway');
	if (!(await allowedAuth(c))) {
		return authJson({ error: AUTH_LIMIT }, 429);
	}
	await clearPreviousChallenge(c.req.raw, gateway);
	return forwardAuth(c.req.raw, gateway);
}

function forwardAuth(original: Request, gateway: ApiGateway) {
	const name = authRoute(original);
	const request = new Request(original);
	request.headers.set('X-Auth-Route', name);
	return gateway.hub(name).fetch(request);
}

async function clearPreviousChallenge(request: Request, gateway: ApiGateway) {
	const token = readCookie(request, 'challenge');
	if (token && new URL(request.url).pathname.endsWith('/options')) {
		await gateway.clearChallenge(token);
	}
}

function allowedAuth<Bindings extends object>(c: ApiContext<Bindings>) {
	return (
		c.req.path.endsWith('/status') ||
		c.req.path.endsWith('/logout') ||
		c.get('gateway').rate(c.req.header('CF-Connecting-IP') ?? 'local', 'auth')
	);
}

async function routeSession<Bindings extends object>(c: ApiContext<Bindings>) {
	if (c.req.path === '/api/session' && !(await rate(c, 'session'))) {
		return authJson({ error: SESSION_LIMIT }, 429);
	}
	return routeRoom(c);
}

function routeRoom<Bindings extends object>(c: ApiContext<Bindings>) {
	const room = roomRoute(c.req.raw);
	if (!/^[a-f0-9]{16}$/.test(room)) {
		return authJson({ error: 'Invalid room' }, 400);
	}
	return forwardRoom(c, room);
}

function forwardRoom<B extends object>(c: ApiContext<B>, room: string) {
	const gateway = c.get('gateway');
	const hub = gateway.hub('room:' + room);
	const url = new URL(c.req.url);
	url.searchParams.set('room', room);
	return c.req.path.startsWith('/api/photos/')
		? photoRequest(c.req.raw, gateway.images, hub)
		: hub.fetch(new Request(url, c.req.raw));
}

function rate<B extends object>(c: ApiContext<B>, kind: string) {
	return c
		.get('gateway')
		.rate(c.req.header('CF-Connecting-IP') ?? 'local', kind);
}

async function sameOrigin(c: Context, next: Next) {
	return c.req.header('Origin') === new URL(c.req.url).origin
		? next()
		: authJson({ error: 'Origin not allowed' }, 403);
}
