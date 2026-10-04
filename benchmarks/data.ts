export const photos = Array.from({ length: 10 }, (_, index) => ({
	name: `photo-${index + 1}.jpg`,
	size: '5 MiB'
}));
