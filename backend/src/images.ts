import { MAX_CONVERSION_BYTES } from '../../shared/photos.ts';
import type { reservePhoto } from './photo-access.ts';

type Reservation = NonNullable<ReturnType<typeof reservePhoto>>;
export type PhotoAuthority = {
	consumePhoto(
		token: string,
		id: string,
		mode: string
	): Promise<Reservation | null>;
	revokePhoto(token: string): Promise<void>;
};
export interface ImageOutput {
	output(
		options: ImageOutputOptions
	): Promise<Pick<ImageTransformationResult, 'response'>>;
}
export interface ImageSource extends ImageOutput {
	transform(options: ImageTransform): ImageOutput;
}
export interface ImageService {
	input(stream: ReadableStream<Uint8Array>): ImageSource;
}
const headers = {
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff'
};
const error = (message: string, status: number) =>
	Response.json({ error: message }, { status, headers });
const tokenOf = (request: Request) =>
	request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
const EXPIRED = '変換の期限が切れました。';
const FAILED = '変換できませんでした。元の写真はそのまま保存できます。';
const TOO_LARGE =
	'変換できる写真は1枚20MiBまでです。元の写真を保存してください。';
const DENIED =
	'この写真は変換できません。変換の有効期限が切れたか、許可されていない操作か、試行回数の上限に達した可能性があります。元の写真を保存してください。';
type Conversion = {
	request: Request;
	images: ImageService;
	grant: Reservation;
	mode: string;
};
export async function photoRequest(
	request: Request,
	images: ImageService,
	authority: PhotoAuthority
) {
	return request.method !== 'POST'
		? error('Method not allowed', 405)
		: routePhoto(request, images, authority);
}

function routePhoto(
	request: Request,
	images: ImageService,
	authority: PhotoAuthority
) {
	return new URL(request.url).pathname === '/api/photos/discard'
		? discard(request, authority)
		: convertRequest(request, images, authority);
}

async function discard(request: Request, authority: PhotoAuthority) {
	await authority.revokePhoto(tokenOf(request));
	return new Response(null, { status: 204, headers });
}

async function authorize(request: Request, authority: PhotoAuthority) {
	const params = new URL(request.url).searchParams;
	const mode = params.get('mode') ?? '';
	const grant = await authority.consumePhoto(
		tokenOf(request),
		params.get('id') ?? '',
		mode
	);
	return { grant, mode };
}

async function convertRequest(
	request: Request,
	images: ImageService,
	authority: PhotoAuthority
) {
	const { grant, mode } = await authorize(request, authority);
	return grant
		? convertWithinLimit({ request, images, grant, mode })
		: error(DENIED, 403);
}

function convertWithinLimit(job: Conversion) {
	return job.grant.photo.size > MAX_CONVERSION_BYTES
		? error(TOO_LARGE, 413)
		: convertAuthorized(job);
}

async function convertAuthorized(job: Conversion) {
	try {
		return await transform(job);
	} catch {
		return error(FAILED, 422);
	}
}

async function transform(job: Conversion) {
	const bytes = await readImage(job.request, job.grant.photo.size);
	if (!isHeifBytes(bytes)) {
		return error('HEIC/HEIF画像を確認してください。', 415);
	}
	if (Date.now() >= job.grant.expiresAt) {
		return error(EXPIRED, 403);
	}
	return checkedOutput(await renderImage(job, bytes), job.grant.expiresAt);
}

export function isHeifBytes(bytes: Uint8Array) {
	const text = new TextDecoder().decode(bytes.slice(4, 12));
	return (
		text.startsWith('ftyp') &&
		['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(text.slice(4))
	);
}

async function readImage(request: Request, size: number) {
	if (!request.body) {
		throw new Error('Empty image');
	}
	return readAndClose(request.body.getReader(), size);
}

async function readAndClose(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	size: number
) {
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

function imageStream(bytes: Uint8Array) {
	return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
}

async function renderImage(job: Conversion, bytes: Uint8Array) {
	const source = job.images.input(imageStream(bytes));
	const image =
		job.mode === 'preview'
			? source.transform({ width: 640, height: 640, fit: 'scale-down' })
			: source;
	const quality = job.mode === 'preview' ? 75 : 90;
	return (await image.output({ format: 'image/jpeg', quality })).response();
}

async function checkedOutput(response: Response, expiresAt: number) {
	if (Date.now() >= expiresAt) {
		await response.body?.cancel();
		return error(EXPIRED, 403);
	}
	return new Response(response.body, {
		headers: { ...headers, 'Content-Type': 'image/jpeg' }
	});
}
