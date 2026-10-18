import { Hono } from 'hono';
import {
	convertPhoto,
	type ImageRenderer,
	type PhotoAuthority
} from '../application/images.ts';
import { bearerToken } from './room.ts';
import { serviceError } from './errors.ts';
const headers = {
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff'
};

export function photoRequest(
	request: Request,
	renderer: ImageRenderer,
	authority: PhotoAuthority
) {
	return photoApp(renderer, authority).fetch(request);
}

function photoApp(renderer: ImageRenderer, authority: PhotoAuthority) {
	const app = new Hono();
	app.post('/api/photos/discard', (c) => discard(c.req.raw, authority));
	app.post('/api/photos/convert', async (c) =>
		conversion(c.req.raw, renderer, authority)
	);
	app.onError((error) => photoError(error));
	app.notFound(methodError);
	return app;
}

async function conversion(
	request: Request,
	renderer: ImageRenderer,
	authority: PhotoAuthority
) {
	const input = conversionInput(request);
	return new Response(await convertPhoto(input, renderer, authority), {
		headers: { ...headers, 'Content-Type': 'image/jpeg' }
	});
}

function conversionInput(request: Request) {
	const params = new URL(request.url).searchParams;
	return {
		token: bearerToken(request),
		id: params.get('id') ?? '',
		mode: params.get('mode') ?? '',
		body: request.body
	};
}

function photoError(error: Error) {
	const response = serviceError(error);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	return response;
}

async function discard(request: Request, authority: PhotoAuthority) {
	await authority.revokePhoto(bearerToken(request));
	return new Response(null, { status: 204, headers });
}

function methodError() {
	return Response.json(
		{ error: 'Method not allowed' },
		{ status: 405, headers }
	);
}
