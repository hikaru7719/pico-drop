export const randomSecret = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, '0')).join('');

export async function secretHash(value: string) {
	const bytes = new TextEncoder().encode(value);
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return Array.from(hash, (n) => n.toString(16).padStart(2, '0')).join('');
}

export function routedToken(room: string | undefined) {
	return room ? room + randomSecret().slice(16) : randomSecret();
}

export const challengeKey = async (token: string) => 'auth:challenge:' + (await secretHash(token));

export const loginKey = async (token: string) => 'auth:login:' + (await secretHash(token));

export async function sessionLoginKey(token: string) {
	return /^[a-f0-9]{64}$/.test(token) ? loginKey(token) : '';
}
