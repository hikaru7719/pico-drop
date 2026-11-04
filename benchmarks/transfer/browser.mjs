/* eslint-disable max-lines-per-function -- Browser benchmark harness runs with real production transfer modules. */
/* eslint-disable typescript/unbound-method -- Prototype instrumentation invokes original methods with .call(this). */
async function fixture(count, size) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 32;
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'));
	const bytes = new Uint8Array(size);
	bytes.fill(37);
	bytes.set(new Uint8Array(await blob.arrayBuffer()));
	return Array.from({ length: count }, (_, i) => {
		const content = bytes.slice();
		content[content.length - 1] = i;
		return new File([content], `photo-${i}.jpg`, { type: 'image/jpeg' });
	});
}

function instrumentation(metrics) {
	const read = File.prototype.arrayBuffer;
	File.prototype.arrayBuffer = async function () {
		const start = performance.now();
		try {
			return await read.call(this);
		} finally {
			metrics.readMs += performance.now() - start;
		}
	};
	const hash = crypto.subtle.digest.bind(crypto.subtle);
	crypto.subtle.digest = async (...args) => {
		const start = performance.now();
		try {
			return await hash(...args);
		} finally {
			metrics.hashMs += performance.now() - start;
		}
	};
	const listen = RTCDataChannel.prototype.addEventListener;
	RTCDataChannel.prototype.addEventListener = function (name, listener, options) {
		if (name === 'bufferedamountlow') {
			const start = performance.now();
			listen.call(
				this,
				name,
				() => {
					metrics.drainMs += performance.now() - start;
				},
				{ once: true }
			);
		}
		return listen.call(this, name, listener, options);
	};
}

window.setup = async ({ variant, files: count, bytes: size, sender }) => {
	const { TransferConnection } = await import(`/${variant}.js`);
	const files = await fixture(count, size);
	const expected = await Promise.all(files.map(async (file) => crypto.subtle.digest('SHA-256', await file.arrayBuffer())));
	const metadata = files.map((file, i) => ({ id: `photo-${i}`, name: file.name, type: file.type, size: file.size }));
	const metrics = { bytes: 0, photos: 0, progressCalls: 0, readMs: 0, hashMs: 0, drainMs: 0 };
	const received = [];
	let started = 0;
	let completed = false;
	let watchdog;
	let resolve;
	let reject;
	window.result = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});

	const touch = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => reject(new Error('Transfer stalled')), 60_000);
	};

	const callbacks = {
		files: sender ? files : [],
		total: count * size,
		bytes: () => metrics.bytes,
		completed: () => completed,
		open: () => {
			started = performance.now();
		},
		touch,
		fail: reject,
		send: () => {},
		peer: () => {},
		receiver: () => {},
		progress: (bytes) => {
			metrics.bytes = bytes;
			metrics.progressCalls++;
			touch();
		},
		received: (file) => {
			received.push(file);
			metrics.photos++;
		},
		complete: async () => {
			completed = true;
			metrics.transferMs = performance.now() - started;
			clearTimeout(watchdog);
			const actual = await Promise.all(received.map(async (file) => crypto.subtle.digest('SHA-256', await file.arrayBuffer())));
			metrics.valid =
				sender ||
				(received.length === count &&
					actual.every(
						(hash, i) =>
							received[i].name === files[i].name &&
							new Uint8Array(hash).every((byte, j) => byte === new Uint8Array(expected[i])[j])
					));
			resolve(metrics);
		}
	};
	instrumentation(metrics);
	window.connection = new TransferConnection(
		{
			type: 'requested',
			id: 'bench',
			files: metadata,
			from: { id: 'sender', name: 'Sender' },
			to: { id: 'receiver', name: 'Receiver' }
		},
		new AbortController().signal,
		sender,
		callbacks
	);
	window.pc = new RTCPeerConnection({ iceServers: [] });
	window.pc.ondatachannel = (event) => window.connection.attach(event.channel);
};

async function gather() {
	if (window.pc.iceGatheringState !== 'complete') {
		await new Promise((resolve) =>
			window.pc.addEventListener('icegatheringstatechange', () => {
				if (window.pc.iceGatheringState === 'complete') {
					resolve();
				}
			})
		);
	}
	return window.pc.localDescription.toJSON();
}

window.offer = async () => {
	window.connection.attach(window.pc.createDataChannel('photos', { ordered: true }));
	await window.pc.setLocalDescription(await window.pc.createOffer());
	return gather();
};

window.answer = async (offer) => {
	await window.pc.setRemoteDescription(offer);
	await window.pc.setLocalDescription(await window.pc.createAnswer());
	return gather();
};
