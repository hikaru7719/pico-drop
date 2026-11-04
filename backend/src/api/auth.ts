import { Hono, type Context, type Next } from 'hono';
import type { AuthService, AuthEnv, AuthInput, AuthResult } from '../application/auth.ts';
import { authJson, authOrigin, bodyJson, readCookie, setCookie } from './http.ts';
import { ServiceError } from '../application/errors.ts';
import { sessionLoginKey } from '../domain/tokens.ts';

export class PasskeyAuth {
	private app = new Hono();

	constructor(
		readonly service: AuthService,
		private env: AuthEnv
	) {
		this.routes();
	}

	private routes() {
		this.middleware();
		this.app.post('/api/auth/status', (c) => this.execute(c.req.raw, 'status'));
		this.app.post('/api/auth/logout', (c) => this.execute(c.req.raw, 'logout'));
		this.ceremonyRoutes();
		this.app.onError(authError);
		this.app.notFound(() => authJson({ error: 'Not found' }, 404));
	}

	private middleware() {
		this.app.use('*', requirePost);
		this.app.use('*', async (c, next) => {
			authOrigin(c.req.raw, this.env);
			await next();
		});
	}

	private ceremonyRoutes() {
		for (const action of CEREMONIES) {
			const path = action.replace(/(Options|Verify)$/, '/$1').toLowerCase();
			this.app.post('/api/auth/' + path, (c) => this.execute(c.req.raw, action));
		}
	}

	route(request: Request) {
		return this.app.fetch(request);
	}

	async loginKey(request: Request) {
		return sessionLoginKey(readCookie(request, 'auth'));
	}

	private input(request: Request): AuthInput {
		return {
			origin: authOrigin(request, this.env),
			auth: readCookie(request, 'auth'),
			challenge: readCookie(request, 'challenge'),
			ip: request.headers.get('CF-Connecting-IP') ?? 'local',
			body: () => bodyJson(request)
		};
	}

	private async execute(request: Request, action: AuthAction) {
		const input = this.input(request);
		if (action !== 'status' && action !== 'logout') {
			await this.service.authorizeAction(input);
		}
		return authResponse(request, await this.service[action](input, input.origin));
	}
}
const CEREMONIES = ['registerOptions', 'loginOptions', 'registerVerify', 'loginVerify'] as const;
const AUTH_ERROR = '認証できませんでした。ユーザーIDやパスキーを確認して再試行してください。';
type AuthAction = 'status' | 'logout' | 'registerOptions' | 'loginOptions' | 'registerVerify' | 'loginVerify';

function authError(error: Error) {
	return error instanceof ServiceError ? authJson({ error: error.message }, 429) : authJson({ error: AUTH_ERROR }, 400);
}

function authResponse(request: Request, result: AuthResult) {
	const response = authJson(result.data);
	if (result.cookie) {
		appendCookie(response, request, result.cookie);
	}
	if (result.clearChallenge) {
		appendCookie(response, request, { kind: 'challenge', token: '' });
	}
	return response;
}

type Cookie = NonNullable<AuthResult['cookie']>;

function appendCookie(response: Response, request: Request, cookie: Cookie) {
	const age = cookie.token ? (cookie.kind === 'auth' ? 604800 : 300) : 0;
	response.headers.append('Set-Cookie', setCookie(request, cookie.kind, cookie.token, age));
}

async function requirePost(c: Context, next: Next) {
	return c.req.method === 'POST' ? next() : authJson({ error: 'Method not allowed' }, 405);
}
