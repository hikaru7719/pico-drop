import { api, readJson } from './api';
import type { InferRequestType } from 'hono/client';

type RegisterResponse = InferRequestType<
	typeof api.auth.register.verify.$post
>['json'];
type LoginResponse = InferRequestType<
	typeof api.auth.login.verify.$post
>['json'];

const readAuth = <T>(response: { ok: boolean; json(): Promise<T> }) =>
	readJson(response, '認証できませんでした。');

export const authApi = {
	status: () => api.auth.status.$post().then(readAuth),
	logout: () => api.auth.logout.$post().then(readAuth),
	registerOptions: (name: string) =>
		api.auth.register.options.$post({ json: { name } }).then(readAuth),
	registerVerify: (json: RegisterResponse) =>
		api.auth.register.verify.$post({ json }).then(readAuth),
	loginOptions: () => api.auth.login.options.$post().then(readAuth),
	loginVerify: (json: LoginResponse) =>
		api.auth.login.verify.$post({ json }).then(readAuth)
};
