import type { IceConfiguration } from '../application/room-ports.ts';
type TurnEnvironment = { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string };

export async function iceServers(
	env: TurnEnvironment
): Promise<IceConfiguration> {
	return env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN
		? turnServers(env)
		: { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], relay: false };
}

function turnHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json'
	};
}

function turnRequest(token: string): RequestInit {
	return {
		method: 'POST',
		headers: turnHeaders(token),
		body: JSON.stringify({ ttl: 900 }),
		signal: AbortSignal.timeout(10_000)
	};
}

async function turnServers(env: TurnEnvironment) {
	const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID!)}/credentials/generate-ice-servers`;
	const response = await fetch(url, turnRequest(env.TURN_KEY_API_TOKEN!));
	if (!response.ok) {
		throw new Error('TURN');
	}
	const data = (await response.json()) as { iceServers: unknown[] };
	return { iceServers: data.iceServers, relay: true };
}
