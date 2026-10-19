export function isHeifBytes(bytes: Uint8Array) {
	const text = new TextDecoder().decode(bytes.slice(4, 12));
	return text.startsWith('ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(text.slice(4));
}
