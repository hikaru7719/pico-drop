import type { ApiGateway } from '../api/app.ts';
import type { Bindings } from './bindings.ts';
import { authenticationApi, requestRate } from './d1-auth.ts';
import { imageRenderer } from './images.ts';

export function gateway(env: Bindings): ApiGateway {
	return {
		hub: (name) => env.HUB.get(env.HUB.idFromName(name)),
		rate: (ip, kind) => requestRate(env, ip, kind),
		auth: async (request) => authenticationApi(env).route(request),
		images: imageRenderer(env.IMAGES)
	};
}
