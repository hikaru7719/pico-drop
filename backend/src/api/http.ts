import type { AuthEnv } from '../application/auth.ts';

export const authJson = (data: unknown, status = 200) =>
	Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

function cookieName(request: Request, kind: string) {
	const secure = new URL(request.url).protocol === 'https:';
	return `${secure ? '__Host-' : ''}pico_${kind}`;
}

export function readCookie(request: Request, kind: string) {
	const prefix = cookieName(request, kind) + '=';
	return (
		(request.headers.get('Cookie') ?? '')
			.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith(prefix))
			?.slice(prefix.length) ?? ''
	);
}

export function setCookie(request: Request, kind: string, value: string, age: number) {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${cookieName(request, kind)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}

export function authOrigin(request: Request, env: AuthEnv) {
	const url = new URL(request.url);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	const origin = env.AUTH_ORIGIN ?? (local ? url.origin : '');
	if (!origin || new URL(origin).origin !== origin || url.origin !== origin) {
		throw new Error('認証の公開URLが設定されていません。');
	}
	requireSecureOrigin(url, local);
	return new URL(origin);
}

export async function bodyJson(request: Request) {
	if (!request.body) {
		throw new Error('Body');
	}
	return new Response(limitedBody(request.body)).json() as Promise<unknown>;
}

function limitedBody(body: ReadableStream<Uint8Array>) {
	return body.pipeThrough(bodyLimit(), { signal: AbortSignal.timeout(5000) });
}

function bodyLimit() {
	let size = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			size += chunk.byteLength;
			checkBodySize(size);
			controller.enqueue(chunk);
		}
	});
}

function checkBodySize(size: number) {
	if (size > 24_000) {
		throw new Error('Body too large');
	}
}

function requireSecureOrigin(url: URL, local: boolean) {
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		throw new Error('HTTPS required');
	}
}
