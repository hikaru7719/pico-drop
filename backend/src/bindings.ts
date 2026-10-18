import type { AuthEnv } from './auth.ts';
export type Bindings = Env &
	AuthEnv & {
		TURN_KEY_ID?: string;
		TURN_KEY_API_TOKEN?: string;
	};
