import type { PhotoAccess } from './photos.ts';
/* eslint-disable no-control-regex -- Reject or sanitize control characters in photo names. */

export const LIMITS = {
	files: 10,
	bytes: 50 * 1024 * 1024,
	chunk: 16 * 1024,
	sessionMs: 30 * 60_000,
	linkMs: 10 * 60_000,
	requestMs: 120_000,
	transferMs: 10 * 60_000
};

export type PhotoMeta = {
	id: string;
	name: string;
	type: string;
	size: number;
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
	| { type: 'create-link'; files: PhotoMeta[] }
	| { type: 'join-link'; token: string }
	| { type: 'revoke-link' }
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
	| { type: 'link-created'; token: string; expiresAt: number }
	| { type: 'link-ended' }
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
			photoAccess?: PhotoAccess;
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

const PHOTO_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/heic',
	'image/heif'
];
const TRANSFER_ACTIONS = ['accept', 'reject', 'cancel', 'complete'];
const INVALID_MESSAGE = '不正なメッセージです。';

function validName(name: unknown): name is string {
	return (
		typeof name === 'string' &&
		name.length >= 1 &&
		name.length <= 100 &&
		!/[\x00-\x1f/\\]/.test(name)
	);
}
function validPhoto(file: unknown): file is PhotoMeta {
	return (
		record(file) &&
		validPhotoFields(file) &&
		typeof file.id === 'string' &&
		/^[a-zA-Z0-9-]{1,40}$/.test(file.id)
	);
}
function validPhotoFields(file: Record<string, unknown>) {
	return (
		validName(file.name) &&
		typeof file.type === 'string' &&
		PHOTO_TYPES.includes(file.type) &&
		Number.isSafeInteger(file.size) &&
		(file.size as number) > 0
	);
}

export function validPhotos(value: unknown): value is PhotoMeta[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > LIMITS.files
	) {
		return false;
	}
	return Array.from(value).every(validPhoto) && validPhotoTotals(value);
}
function validPhotoTotals(files: PhotoMeta[]) {
	return (
		new Set(files.map((file) => file.id)).size === files.length &&
		files.reduce((total, file) => total + file.size, 0) <= LIMITS.bytes
	);
}

function validDescription(value: unknown) {
	return (
		record(value) &&
		['offer', 'answer'].includes(String(value.type)) &&
		typeof value.sdp === 'string' &&
		value.sdp.length < 20_000
	);
}
function validCandidateFields(value: Record<string, unknown>) {
	return (
		(value.sdpMid == null || typeof value.sdpMid === 'string') &&
		(value.sdpMLineIndex == null || Number.isInteger(value.sdpMLineIndex)) &&
		(value.usernameFragment == null ||
			typeof value.usernameFragment === 'string')
	);
}
function validCandidate(value: unknown) {
	return (
		record(value) &&
		typeof value.candidate === 'string' &&
		value.candidate.length < 2000 &&
		validCandidateFields(value)
	);
}
function validSignal(value: unknown) {
	return (
		record(value) &&
		(validDescription(value.description) || validCandidate(value.candidate))
	);
}
function validTransferMessage(value: Record<string, unknown>) {
	return (
		typeof value.id === 'string' &&
		value.id.length <= 40 &&
		(TRANSFER_ACTIONS.includes(String(value.type)) ||
			(value.type === 'signal' && validSignal(value.signal)))
	);
}
const messageValidators: Record<
	string,
	(value: Record<string, unknown>) => boolean
> = {
	auth: (value) =>
		typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token),
	'create-link': (value) => validPhotos(value.files),
	'join-link': (value) =>
		typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token),
	'revoke-link': () => true
};
export function parseClient(value: unknown): ClientMessage {
	if (!record(value) || typeof value.type !== 'string') {
		throw new Error(INVALID_MESSAGE);
	}
	return parseRecord(value, value.type);
}
function messageValidator(type: string) {
	return Object.hasOwn(messageValidators, type)
		? messageValidators[type]
		: validTransferMessage;
}
function parseRecord(
	value: Record<string, unknown>,
	type: string
): ClientMessage {
	if (!messageValidator(type)(value)) {
		throw new Error(INVALID_MESSAGE);
	}
	return value as ClientMessage;
}

export type TransferState = {
	id: string;
	from: Device;
	to: Device;
	files: PhotoMeta[];
	started: boolean;
	expiresAt: number;
};

type Authorization = {
	transfer: TransferState;
	actor: string;
	action: string;
	now: number;
};
const authorizationRules: [(context: Authorization) => boolean, string][] = [
	[
		({ transfer: t, actor, now }) =>
			t.expiresAt <= now || ![t.from.id, t.to.id].includes(actor),
		'転送が期限切れ、または操作できません。'
	],
	[
		({ transfer: t, actor, action }) =>
			['accept', 'reject', 'complete'].includes(action) && actor !== t.to.id,
		'受信者のみ操作できます。'
	],
	[
		({ transfer: t, action }) =>
			['accept', 'reject'].includes(action) && t.started,
		'すでに応答済みです。'
	],
	[
		({ transfer: t, action }) =>
			['signal', 'complete'].includes(action) && !t.started,
		'先に受信を承諾してください。'
	]
];
export function authorizeTransfer(
	t: TransferState,
	actor: string,
	action: string,
	now = Date.now()
): void {
	checkAuthorization({ transfer: t, actor, action, now });
}
function checkAuthorization(context: Authorization) {
	const failure = authorizationRules.find(([invalid]) => invalid(context));
	if (failure) {
		throw new Error(failure[1]);
	}
}
