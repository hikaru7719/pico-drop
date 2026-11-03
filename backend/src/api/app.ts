import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { authJson } from './http.ts';
import { roomRoute } from './routing.ts';
import { photoRequest } from './images.ts';
import type { ImageRenderer, PhotoAuthority } from '../application/images.ts';
import { serviceError } from './errors.ts';
import { rpc, type AccountStatus, type RegistrationOptions as RegOptions, type AuthenticationOptions } from './rpc.ts';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Session } from '../../../shared/protocol.ts';
import type { ConversionMode } from '../../../shared/photos.ts';
import type { IceConfiguration } from '../application/room-ports.ts';

export interface HubDestination extends PhotoAuthority {
	fetch(request: Request): Promise<Response>;
}
export interface ApiGateway {
	hub(name: string): HubDestination;
	auth(request: Request): Promise<Response>;
	rate(ip: string, kind: string): Promise<boolean>;
	images: ImageRenderer;
}
type ApiEnv<Bindings extends object> = {
	Bindings: Bindings;
	Variables: { gateway: ApiGateway };
};
type ApiContext<Bindings extends object> = Context<ApiEnv<Bindings>>;
const SESSION_LIMIT = '接続回数が多すぎます。1分後に再試行してください。';

export function createApp<Bindings extends object>(gateway: (env: Bindings) => ApiGateway) {
	const app = new Hono<ApiEnv<Bindings>>();
	configure(app, gateway);
	const api = routes(app);
	fallbackRoutes(app);
	app.onError(serviceError);
	return api;
}

function configure<B extends object>(app: Hono<ApiEnv<B>>, gateway: (env: B) => ApiGateway) {
	app.all('/api/health', health);
	app.use('*', sameOrigin);
	app.all('/api/auth', () => authJson({ error: 'Not found' }, 404));
	dependencies(app, gateway);
}

function dependencies<B extends object>(app: Hono<ApiEnv<B>>, gateway: (env: B) => ApiGateway) {
	app.use('*', async (c, next) => {
		c.set('gateway', gateway(c.env));
		await next();
	});
}

export type AppType = ReturnType<typeof createApp>;
type RoomQuery = { query: { room?: string } };
type PhotoQuery = { query: { id: string; mode: ConversionMode } };
type RegisterInput = { json: { name: string } };
type RegisterProof = { json: RegistrationResponseJSON };
type LoginProof = { json: AuthenticationResponseJSON };

function routes<B extends object>(app: Hono<ApiEnv<B>>) {
	const session = rpc((c: ApiContext<B>) => routeSession(c));
	const socket = rpc(async (c: ApiContext<B>) => routeRoom(c));
	return authRoutes(app)
		.post('/api/session', session<Session, RoomQuery, 201>())
		.post('/api/ice', session<IceConfiguration>())
		.post('/api/photos/convert', session<never, PhotoQuery>())
		.post('/api/photos/discard', session<null, {}, 204>())
		.get('/api/ws', socket<never, RoomQuery>());
}

const SESSION_PATHS = ['/api/session', '/api/ice', '/api/photos/convert', '/api/photos/discard'];

function fallbackRoutes<B extends object>(app: Hono<ApiEnv<B>>) {
	app.notFound(() => authJson({ error: 'Not found' }, 404));
	app.all('/api/ws', (c) => routeRoom(c));
	app.post('/api/auth/*', (c) => routeAuth(c));
	app.all('/api/auth/*', methodError);
	for (const path of SESSION_PATHS) {
		app.all(path, methodError);
	}
}

function authRoutes<B extends object>(app: Hono<ApiEnv<B>>) {
	const auth = rpc((c: ApiContext<B>) => routeAuth(c));
	return app
		.post('/api/auth/status', auth<AccountStatus>())
		.post('/api/auth/logout', auth<AccountStatus>())
		.post('/api/auth/register/options', auth<RegOptions, RegisterInput>())
		.post('/api/auth/register/verify', auth<AccountStatus, RegisterProof>())
		.post('/api/auth/login/options', auth<AuthenticationOptions>())
		.post('/api/auth/login/verify', auth<AccountStatus, LoginProof>());
}

const methodError = () => authJson({ error: 'Method not allowed' }, 405);

async function routeAuth<Bindings extends object>(c: ApiContext<Bindings>) {
	const gateway = c.get('gateway');
	return gateway.auth(c.req.raw);
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
	return c.get('gateway').rate(c.req.header('CF-Connecting-IP') ?? 'local', kind);
}

async function sameOrigin(c: Context, next: Next) {
	return c.req.header('Origin') === new URL(c.req.url).origin ? next() : authJson({ error: 'Origin not allowed' }, 403);
}

const health = () => authJson({ status: 'ok', service: 'pico-drop-backend' });
