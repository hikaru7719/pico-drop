/** Received originals and derived images live only for this viewing window. */
export const PHOTO_LIFETIME_MS = 10 * 60_000;
export const MAX_CONVERSION_BYTES = 20 * 1024 * 1024;
export type ConversionMode = 'preview' | 'jpeg';
export type PhotoAccess = { token: string; expiresAt: number };
export const isHeic = (type: string) =>
	['image/heic', 'image/heif'].includes(type);
