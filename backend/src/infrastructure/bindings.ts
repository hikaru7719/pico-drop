import type { AuthEnv } from '../application/auth.ts';

export type Bindings = Env &
	AuthEnv & {
		TURN_KEY_ID?: string;
		TURN_KEY_API_TOKEN?: string;
	};
