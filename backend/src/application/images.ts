import { isHeifBytes } from '../domain/images.ts';
import { ServiceError } from './errors.ts';
import { MAX_CONVERSION_BYTES } from '../../../shared/photos.ts';
import type { reservePhoto } from '../domain/photos.ts';

type Reservation = NonNullable<ReturnType<typeof reservePhoto>>;

export type PhotoAuthority = {
	consumePhoto(token: string, id: string, mode: string): Promise<Reservation | null>;
	revokePhoto(token: string): Promise<void>;
};

const EXPIRED = '変換の期限が切れました。';
const FAILED = '変換できませんでした。元の写真はそのまま保存できます。';
const TOO_LARGE = '変換できる写真は1枚20MiBまでです。元の写真を保存してください。';
const DENIED =
	'この写真は変換できません。変換の有効期限が切れたか、許可されていない操作か、試行回数の上限に達した可能性があります。元の写真を保存してください。';
type Conversion = {
	body: ReadableStream<Uint8Array> | null;
	renderer: ImageRenderer;
	grant: Reservation;
	mode: string;
};

export type ImageRenderer = {
	render(bytes: Uint8Array, mode: string): Promise<ReadableStream<Uint8Array> | null>;
};

export type ConversionInput = {
	token: string;
	id: string;
	mode: string;
	body: ReadableStream<Uint8Array> | null;
};

export async function convertPhoto(input: ConversionInput, renderer: ImageRenderer, authority: PhotoAuthority) {
	const grant = await authority.consumePhoto(input.token, input.id, input.mode);
	return convertWithinLimit({ ...input, renderer, grant: requireGrant(grant) });
}

function convertWithinLimit(job: Conversion) {
	if (job.grant.photo.size > MAX_CONVERSION_BYTES) {
		throw new ServiceError('too-large', TOO_LARGE);
	}
	return convertAuthorized(job);
}

async function convertAuthorized(job: Conversion) {
	try {
		return await transform(job);
	} catch (error) {
		if (error instanceof ServiceError) {
			throw error;
		}
		throw new ServiceError('conversion-failed', FAILED);
	}
}

async function transform(job: Conversion) {
	const bytes = await readImage(job.body, job.grant.photo.size);
	validateImage(bytes, job.grant.expiresAt);
	return checkedOutput(await job.renderer.render(bytes, job.mode), job.grant.expiresAt);
}

function validateImage(bytes: Uint8Array, expiresAt: number) {
	if (!isHeifBytes(bytes)) {
		throw new ServiceError('unsupported', 'HEIC/HEIF画像を確認してください。');
	}
	if (Date.now() >= expiresAt) {
		throw new ServiceError('forbidden', EXPIRED);
	}
}

async function readImage(body: ReadableStream<Uint8Array> | null, size: number) {
	if (!body) {
		throw new Error('Empty image');
	}
	return readAndClose(body.getReader(), size);
}

async function readAndClose(reader: ReadableStreamDefaultReader<Uint8Array>, size: number) {
	try {
		return await fillImage(reader, new Uint8Array(size));
	} finally {
		await reader.cancel().catch(() => {});
	}
}

type ImageReader = ReadableStreamDefaultReader<Uint8Array>;

async function fillImage(reader: ImageReader, bytes: Uint8Array) {
	const offset = await readChunks(reader, bytes);
	if (offset !== bytes.length) {
		throw new Error('Incomplete image');
	}
	return bytes;
}

async function readChunks(reader: ImageReader, bytes: Uint8Array) {
	let offset = 0;
	let chunk = await reader.read();
	while (!chunk.done) {
		offset = appendChunk(bytes, chunk.value, offset);
		chunk = await reader.read();
	}
	return offset;
}

function appendChunk(bytes: Uint8Array, chunk: Uint8Array, offset: number) {
	if (offset + chunk.length > bytes.length) {
		throw new Error('Oversize image');
	}
	bytes.set(chunk, offset);
	return offset + chunk.length;
}

async function checkedOutput(stream: ReadableStream<Uint8Array> | null, expiresAt: number) {
	if (Date.now() >= expiresAt) {
		await stream?.cancel();
		throw new ServiceError('forbidden', EXPIRED);
	}
	return stream;
}

function requireGrant(grant: Reservation | null) {
	if (!grant) {
		throw new ServiceError('forbidden', DENIED);
	}
	return grant;
}
