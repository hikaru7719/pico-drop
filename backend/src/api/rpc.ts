import type { Context, Env, Handler, TypedResponse } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import type { AuthService, PasskeyVerifier } from '../application/auth.ts';

export type AccountStatus = Awaited<ReturnType<AuthService['status']>>['data'];
export type RegistrationOptions = Awaited<ReturnType<PasskeyVerifier['generateRegistrationOptions']>>;
export type AuthenticationOptions = Awaited<ReturnType<PasskeyVerifier['generateAuthenticationOptions']>>;

// Declare the wire types without reading response bodies. Validation, body limits
// and cookies belong to the authentication and room HTTP adapters.
type RpcHandler<E extends Env, Output, Input extends object, Status extends StatusCode> = Handler<
	E,
	string,
	{ in: Input },
	Promise<Response & TypedResponse<Output, Status, 'json'>>
>;
type Forward<E extends Env> = (c: Context<E>) => Promise<Response>;

export function rpc<E extends Env>(handler: Forward<E>) {
	return <Output, Input extends object = {}, Status extends StatusCode = 200>(): RpcHandler<E, Output, Input, Status> =>
		async (c) =>
			(await handler(c)) as Response & TypedResponse<Output, Status, 'json'>;
}
