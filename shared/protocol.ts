/* eslint-disable no-control-regex -- Reject or sanitize control characters in photo names. */

export const LIMITS = {
	files: 10,
	bytes: 50 * 1024 * 1024,
	chunk: 16 * 1024,
	sessionMs: 30 * 60_000,
	presenceMs: 90_000,
	requestMs: 120_000,
	transferMs: 10 * 60_000
};

export type PhotoMeta = {
	id: string;
	name: string;
	type: string;
	size: number;
};

export type Location = {
	latitude: number;
	longitude: number;
	accuracy: number;
};

export type Device = {
	id: string;
	name: string;
};

export type Session = Device & {
	token: string;
	expiresAt: number;
};

export type Signal =
	| {
			description: {
				type: 'offer' | 'answer';
				sdp: string;
			};
	  }
	| {
			candidate: {
				candidate: string;
				sdpMid?: string | null;
				sdpMLineIndex?: number | null;
				usernameFragment?: string | null;
			};
	  };

export type ClientMessage =
	| {
			type: 'auth';
			token: string;
	  }
	| {
			type: 'presence';
			location: Location | null;
	  }
	| {
			type: 'request';
			to: string;
			files: PhotoMeta[];
	  }
	| {
			type: 'accept' | 'reject' | 'cancel' | 'complete';
			id: string;
	  }
	| {
			type: 'signal';
			id: string;
			signal: Signal;
	  };

export type ServerMessage =
	| {
			type: 'ready';
			device: Device;
	  }
	| {
			type: 'nearby';
			devices: Device[];
	  }
	| {
			type: 'requested';
			id: string;
			from: Device;
			to: Device;
			files: PhotoMeta[];
	  }
	| {
			type: 'start';
			id: string;
	  }
	| {
			type: 'ended';
			id: string;
			reason:
				| 'rejected'
				| 'cancelled'
				| 'disconnected'
				| 'timeout'
				| 'complete';
	  }
	| {
			type: 'signal';
			id: string;
			signal: Signal;
	  }
	| {
			type: 'error';
			message: string;
	  };

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validPhotos(value: unknown): value is PhotoMeta[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.files)
		return false;
	const ids = new Set<string>();
	let total = 0;
	for (const file of value) {
		if (
			!record(file) ||
			typeof file.id !== 'string' ||
			!/^[a-zA-Z0-9-]{1,40}$/.test(file.id) ||
			ids.has(file.id) ||
			typeof file.name !== 'string' ||
			file.name.length < 1 ||
			file.name.length > 100 ||
			/[\x00-\x1f/\\]/.test(file.name) ||
			typeof file.type !== 'string' ||
			![
				'image/jpeg',
				'image/png',
				'image/webp',
				'image/heic',
				'image/heif'
			].includes(file.type) ||
			!Number.isSafeInteger(file.size) ||
			(file.size as number) <= 0
		)
			return false;
		ids.add(file.id);
		total += file.size as number;
	}
	return total <= LIMITS.bytes;
}

export function validLocation(value: unknown): value is Location {
	return (
		record(value) &&
		typeof value.latitude === 'number' &&
		Number.isFinite(value.latitude) &&
		Math.abs(value.latitude) <= 90 &&
		typeof value.longitude === 'number' &&
		Number.isFinite(value.longitude) &&
		Math.abs(value.longitude) <= 180 &&
		typeof value.accuracy === 'number' &&
		Number.isFinite(value.accuracy) &&
		value.accuracy >= 0 &&
		value.accuracy <= 10_000
	);
}

export function nearby(a: Location, b: Location): boolean {
	const rad = Math.PI / 180;
	const h =
		Math.sin(((a.latitude - b.latitude) * rad) / 2) ** 2 +
		Math.cos(a.latitude * rad) *
			Math.cos(b.latitude * rad) *
			Math.sin(((a.longitude - b.longitude) * rad) / 2) ** 2;
	return (
		12_742_000 * Math.asin(Math.sqrt(Math.min(1, h))) <=
		300 + Math.min(a.accuracy, 500) + Math.min(b.accuracy, 500)
	);
}

export function parseClient(value: unknown): ClientMessage {
	if (!record(value) || typeof value.type !== 'string')
		throw new Error('不正なメッセージです。');
	if (
		value.type === 'auth' &&
		typeof value.token === 'string' &&
		/^[a-f0-9]{64}$/.test(value.token)
	)
		return value as ClientMessage;
	if (
		value.type === 'presence' &&
		(value.location === null || validLocation(value.location))
	)
		return value as ClientMessage;
	if (
		value.type === 'request' &&
		typeof value.to === 'string' &&
		value.to.length <= 40 &&
		validPhotos(value.files)
	)
		return value as ClientMessage;
	if (typeof value.id === 'string' && value.id.length <= 40) {
		if (['accept', 'reject', 'cancel', 'complete'].includes(value.type))
			return value as ClientMessage;
		if (value.type === 'signal' && record(value.signal)) {
			const s = value.signal;
			if (
				record(s.description) &&
				['offer', 'answer'].includes(String(s.description.type)) &&
				typeof s.description.sdp === 'string' &&
				s.description.sdp.length < 20_000
			)
				return value as ClientMessage;
			if (
				record(s.candidate) &&
				typeof s.candidate.candidate === 'string' &&
				s.candidate.candidate.length < 2000 &&
				(s.candidate.sdpMid == null ||
					typeof s.candidate.sdpMid === 'string') &&
				(s.candidate.sdpMLineIndex == null ||
					Number.isInteger(s.candidate.sdpMLineIndex)) &&
				(s.candidate.usernameFragment == null ||
					typeof s.candidate.usernameFragment === 'string')
			)
				return value as ClientMessage;
		}
	}
	throw new Error('不正なメッセージです。');
}

export type TransferState = {
	id: string;
	from: Device;
	to: Device;
	files: PhotoMeta[];
	started: boolean;
	expiresAt: number;
};

export function authorizeTransfer(
	t: TransferState,
	actor: string,
	action: string,
	now = Date.now()
): void {
	if (t.expiresAt <= now || ![t.from.id, t.to.id].includes(actor))
		throw new Error('転送が期限切れ、または操作できません。');
	if (
		(action === 'accept' || action === 'reject' || action === 'complete') &&
		actor !== t.to.id
	)
		throw new Error('受信者のみ操作できます。');
	if ((action === 'accept' || action === 'reject') && t.started)
		throw new Error('すでに応答済みです。');
	if ((action === 'signal' || action === 'complete') && !t.started)
		throw new Error('先に受信を承諾してください。');
}
