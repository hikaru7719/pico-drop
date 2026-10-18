import type { ApiGateway } from '../api/app.ts';
import type { Bindings } from './bindings.ts';
import { hubFor, requestRate, clearPreviousChallenge } from './hub-network.ts';
import { imageRenderer } from './images.ts';

export function gateway(env: Bindings): ApiGateway {
	return {
		hub: (name) => hubFor(env, name),
		rate: (ip, kind) => requestRate(env, ip, kind),
		clearChallenge: (token) => clearPreviousChallenge(env, token),
		images: imageRenderer(env.IMAGES)
	};
}
