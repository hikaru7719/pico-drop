import { Hono } from 'hono';
import type { RoomService } from '../application/room.ts';
import { authJson, readCookie } from './http.ts';
import { sessionLoginKey } from '../domain/tokens.ts';
import { serviceError } from './errors.ts';
type Upgrade = () => Promise<Response>;
export function roomApp(service: RoomService, upgrade: Upgrade) {
	const app = new Hono();
	app.all('/api/ws', (c) => upgradeRequest(c.req.raw, upgrade));
	sessionRoutes(app, service);
	app.notFound(methodError);
	app.onError(serviceError);
	return app;
}
function sessionRoutes(app: Hono, service: RoomService) {
	app.post('/api/session', async (c) =>
		authJson(await service.createSession(await sessionInput(c.req.raw)), 201)
	);
	app.post('/api/ice', async (c) =>
		authJson(await service.ice(bearerToken(c.req.raw)))
	);
}
async function sessionInput(request: Request) {
	return {
		room: new URL(request.url).searchParams.get('room') ?? undefined,
		authKey: await sessionLoginKey(readCookie(request, 'auth'))
	};
}
export const bearerToken = (request: Request) =>
	request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
const methodError = () => authJson({ error: 'Method not allowed' }, 405);

function upgradeRequest(request: Request, upgrade: () => Promise<Response>) {
	return request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
		? upgrade()
		: methodError();
}
