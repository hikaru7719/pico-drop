import type { ImageRenderer } from '../application/images.ts';
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

export const imageRenderer = (images: ImageService): ImageRenderer => ({
	render: (bytes, mode) => renderImage(images, bytes, mode)
});

function imageStream(bytes: Uint8Array) {
	return new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
}

async function renderImage(
	images: ImageService,
	bytes: Uint8Array,
	mode: string
) {
	const image = resize(images.input(imageStream(bytes)), mode);
	const quality = mode === 'preview' ? 75 : 90;
	return (await image.output({ format: 'image/jpeg', quality })).response()
		.body;
}

function resize(source: ImageSource, mode: string) {
	return mode === 'preview'
		? source.transform({ width: 640, height: 640, fit: 'scale-down' })
		: source;
}
