const sockets = [];
class TestSocket {
	queue = [];
	waiter = undefined;
	constructor(room) {
		this.ws = new WebSocket(
			location.origin.replace('http', 'ws') + '/api/ws?room=' + room
		);
		sockets.push(this.ws);
		this.ws.onmessage = (e) => this.receive(JSON.parse(e.data));
	}
	receive(message) {
		const resolve = this.waiter;
		if (resolve) {
			this.waiter = undefined;
			resolve(message);
		} else {
			this.queue.push(message);
		}
	}
	wait(type) {
		return new Promise((resolve, reject) =>
			this.waitForMessage(type, resolve, reject)
		);
	}
	waitForMessage(type, resolve, reject) {
		const timer = setTimeout(
			() => reject(new Error('Timed out: ' + type)),
			5000
		);
		this.waiter = (message) => {
			clearTimeout(timer);
			resolve(message);
		};
	}

	async next(type) {
		for (let i = 0; i < 20; i++) {
			const message = this.queue.shift() || (await this.wait(type));
			if (message.type === type) {
				return message;
			}
		}
		throw new Error('Missing ' + type);
	}
	send(message) {
		this.ws.send(JSON.stringify(message));
	}
	async open(token) {
		await new Promise((resolve) => {
			this.ws.onopen = resolve;
		});
		this.send({ type: 'auth', token });
		return this;
	}
	closed() {
		return new Promise((resolve) => {
			this.ws.onclose = (e) => resolve(e.code);
		});
	}
}
const session = async (room = '') =>
	(
		await fetch('/api/session' + (room ? '?room=' + room : ''), {
			method: 'POST'
		})
	).json();
async function participant(room) {
	const identity = await session(room);
	const socket = await new TestSocket(identity.room).open(identity.token);
	await socket.next('ready');
	return { identity, socket };
}
async function request(a, b) {
	const files = [{ id: 'p', name: 'photo.jpg', type: 'image/jpeg', size: 8 }];
	a.socket.send({ type: 'create-link', files });
	const link = await a.socket.next('link-created');
	b.socket.send({ type: 'join-link', token: link.token });
	return requested(a, b);
}
async function requested(a, b) {
	const transfer = await a.socket.next('requested');
	const received = await b.socket.next('requested');
	return {
		transfer,
		sameRequest: JSON.stringify(transfer) === JSON.stringify(received)
	};
}
async function errorFor(socket, message) {
	socket.send(message);
	return (await socket.next('error')).message;
}
async function iceStatus(token) {
	const headers = { Authorization: 'Bearer ' + token };
	return (await fetch('/api/ice', { method: 'POST', headers })).status;
}
async function preApproval(a, c, signal) {
	const result = {};
	result.preAccept = await errorFor(a.socket, signal);
	result.senderAccept = await errorFor(a.socket, decision('accept', signal.id));
	result.outsider = await errorFor(c.socket, { type: 'cancel', id: signal.id });
	result.iceStatus = await iceStatus(a.identity.token);
	return result;
}

async function accept(a, b, id) {
	b.socket.send({ type: 'accept', id });
	await a.socket.next('start');
	await b.socket.next('start');
}
async function approved(a, b, signal) {
	await accept(a, b, signal.id);
	a.socket.send(signal);
	const forwarded = await b.socket.next('signal');
	const senderComplete = await errorFor(a.socket, {
		type: 'complete',
		id: signal.id
	});
	return { forwarded, senderComplete };
}

async function cancelled(a, b, signal) {
	b.socket.send({ type: 'cancel', id: signal.id });
	await a.socket.next('ended');
	await b.socket.next('ended');
	return errorFor(a.socket, signal);
}
async function tokenChecks(a) {
	const invalid = await new TestSocket(a.identity.room).open('0'.repeat(64));
	const invalidCode = await invalid.closed();
	a.socket.ws.close();
	await a.socket.closed();
	const replay = await new TestSocket(a.identity.room).open(a.identity.token);
	return { invalidCode, replayCode: await replay.closed() };
}
function offer(id) {
	return {
		type: 'signal',
		id,
		signal: { description: { type: 'offer', sdp: 'test' } }
	};
}
async function transferChecks(a, b, c) {
	const { transfer, sameRequest } = await request(a, b);
	const signal = offer(transfer.id);
	const before = await preApproval(a, c, signal);
	const after = await approved(a, b, signal);
	const stale = await cancelled(a, b, signal);
	return { sameRequest, ...before, ...after, stale };
}

async function scenario() {
	const a = await participant(),
		b = await participant(a.identity.room),
		c = await participant(a.identity.room);

	const transfer = await transferChecks(a, b, c);
	const isolation = await isolatedRoom(a);
	return { ...transfer, ...isolation, ...(await tokenChecks(a)) };
}
window.runApiTests = async () => {
	try {
		return await scenario();
	} finally {
		for (const ws of sockets) {
			ws.close();
		}
	}
};

function decision(type, id) {
	return { type, id };
}

async function isolatedRoom(a) {
	const d = await participant();
	const e = await participant(d.identity.room);
	const wrong = await new TestSocket(d.identity.room).open(a.identity.token);
	const wrongRoomCode = await wrong.closed();
	const photoRoom = await completeRoomTransfer(d, e);
	const distinctRooms = a.identity.room !== d.identity.room;
	return { distinctRooms, wrongRoomCode, photoRoom };
}

async function completeRoomTransfer(d, e) {
	const { transfer } = await request(d, e);
	await accept(d, e, transfer.id);
	e.socket.send({ type: 'complete', id: transfer.id });
	const ended = await e.socket.next('ended');
	return ended.photoAccess.token.slice(0, 16) === d.identity.room;
}
