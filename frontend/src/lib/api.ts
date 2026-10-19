import { hc } from 'hono/client';
import type { AppType } from '../../../backend/src/api/app.ts';

export const createApi = (request: typeof fetch = (...args) => fetch(...args)) => hc<AppType>('/', { fetch: request }).api;

export const api = createApi();
type ApiError = { error?: unknown } | null;

export async function readJson<T>(response: { ok: boolean; json(): Promise<T> }, fallback: string): Promise<T> {
	if (!response.ok) {
		const data = (await response.json().catch(() => null)) as ApiError;
		throw new Error(typeof data?.error === 'string' ? data.error : fallback);
	}
	return response.json();
}
