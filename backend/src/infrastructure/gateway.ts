import type { ApiGateway } from '../api/app.ts';
import type { Bindings } from './bindings.ts';
import { hubFor } from './hub-network.ts';
import { authentication, requestRate } from './d1-auth.ts';
import { imageRenderer } from './images.ts';

export function gateway(env: Bindings): ApiGateway {
	return {
		hub: (name) => hubFor(env, name),
		rate: (ip, kind) => requestRate(env, ip, kind),
		auth: async (request) => authentication(env).route(request),
		images: imageRenderer(env.IMAGES)
	};
}
