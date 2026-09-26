function centeredScroll(card) {
	const desired = scrollY + card.top + card.height / 2 - innerHeight / 2;
	return Math.max(
		0,
		Math.min(desired, document.documentElement.scrollHeight - innerHeight)
	);
}
window.discoveryCentered = () => {
	const card = document
		.querySelector('[aria-labelledby="nearby-heading"]')
		.getBoundingClientRect();
	const collapsed =
		document.querySelector('.intro-shell').getBoundingClientRect().height < 1;
	return Math.abs(scrollY - centeredScroll(card)) < 3 && collapsed;
};
function fillImage(image) {
	for (let i = 0; i < image.data.length; i += 4) {
		image.data[i] = i % 251;
		image.data[i + 1] = (i * 17) % 253;
		image.data[i + 2] = (i * 43) % 255;
		image.data[i + 3] = 255;
	}
}
window.testJpeg = () => {
	const canvas = document.createElement('canvas');
	canvas.width = 640;
	canvas.height = 480;
	const ctx = canvas.getContext('2d');
	const image = ctx.createImageData(canvas.width, canvas.height);
	fillImage(image);
	ctx.putImageData(image, 0, 0);
	return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
};
