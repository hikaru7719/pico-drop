import type {
	startRegistration,
	startAuthentication
} from '@simplewebauthn/browser';

type Status = { account: { name: string } | null };
type Responses = {
	'register/options': Parameters<typeof startRegistration>[0]['optionsJSON'];
	'login/options': Parameters<typeof startAuthentication>[0]['optionsJSON'];
	'register/verify': Status;
	'login/verify': Status;
	status: Status;
	logout: Status;
};

export function authApi<K extends keyof Responses>(
	path: K,
	body?: unknown
): Promise<Responses[K]> {
	return fetch('/api/auth/' + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then(readResponse) as Promise<Responses[K]>;
}

async function readResponse(response: Response) {
	const data = (await response.json()) as { error?: string };
	if (!response.ok) {
		throw new Error(data.error ?? '認証できませんでした。');
	}
	return data;
}
