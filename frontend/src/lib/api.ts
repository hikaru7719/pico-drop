import { hc } from 'hono/client';
import type { AppType } from '../../../backend/src/api/app.ts';

export const createApi = (
	request: typeof fetch = (...args) => fetch(...args)
) => hc<AppType>('/', { fetch: request }).api;

export const api = createApi();

export async function readJson<T>(
	response: { ok: boolean; json(): Promise<T> },
	fallback: string
): Promise<T> {
	if (!response.ok) {
		const data = (await response.json()) as { error?: string };
		throw new Error(data.error ?? fallback);
	}
	return response.json();
}
