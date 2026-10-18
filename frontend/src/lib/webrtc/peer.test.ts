import type { DataChannel, PeerConnection } from './ports';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { PhotoPeer } from './peer';

class PeerChannel extends EventTarget implements DataChannel {
	readyState: RTCDataChannelState = 'connecting';
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	binaryType: BinaryType = 'blob';
	onopen = null;
	onclose = null;
	onerror = null;
	onmessage = null;
	send = vi.fn();
	close = vi.fn();
}
class PeerFixture implements PeerConnection {
	connectionState: RTCPeerConnectionState = 'new';
	localDescription: (RTCSessionDescriptionInit & { sdp: string }) | null = null;
	remoteDescription: RTCSessionDescriptionInit | null = null;
	onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
	ondatachannel: ((event: { channel: DataChannel }) => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	dataChannel = new PeerChannel();
	createDataChannel = vi.fn(() => this.dataChannel);
	createOffer = vi.fn(async () => ({
		type: 'offer' as const,
		sdp: 'offer-sdp'
	}));
	createAnswer = vi.fn(async () => ({
		type: 'answer' as const,
		sdp: 'answer-sdp'
	}));
	addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
	close = vi.fn();
	signal = vi.fn();
	channel = vi.fn();
	fail = vi.fn();
	peer: PhotoPeer;
	constructor() {
		vi.useFakeTimers();
		this.peer = new PhotoPeer(this, this.signal, this.channel, this.fail);
		onTestFinished(() => this.peer.close());
	}
	async setLocalDescription(value: RTCSessionDescriptionInit) {
		this.localDescription = { ...value, sdp: value.sdp ?? '' };
	}
	async setRemoteDescription(value: RTCSessionDescriptionInit) {
		this.remoteDescription = value;
	}
	change(state: RTCPeerConnectionState) {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}
}
const candidate = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };
afterEach(() => vi.useRealTimers());

test('offer creates an ordered channel and publishes the local SDP', async () => {
	const f = new PeerFixture();
	await f.peer.offer(f.channel);
	expect(f.createDataChannel).toHaveBeenCalledWith('photos', { ordered: true });
	expect(f.channel).toHaveBeenCalledWith(f.dataChannel);
	expect(f.signal).toHaveBeenCalledWith({ description: f.localDescription });
});
test('ICE candidates wait for the remote offer then flush before answering', async () => {
	const f = new PeerFixture();
	await f.peer.receive({ candidate });
	expect(f.addIceCandidate).not.toHaveBeenCalled();
	await f.peer.receive({ description: { type: 'offer', sdp: 'remote' } });
	expect(f.addIceCandidate).toHaveBeenCalledExactlyOnceWith(candidate);
	expect(f.signal).toHaveBeenCalledWith({
		description: { type: 'answer', sdp: 'answer-sdp' }
	});
});
test('remote answers do not generate another answer and candidates apply immediately', async () => {
	const f = new PeerFixture();
	await f.peer.receive({
		description: { type: 'answer', sdp: 'remote' }
	});
	await f.peer.receive({ candidate });
	expect(f.addIceCandidate).toHaveBeenCalledExactlyOnceWith(candidate);
	expect(f.createAnswer).not.toHaveBeenCalled();
});
test('candidate and data-channel events are forwarded, ignoring end-of-candidates', () => {
	const f = new PeerFixture();
	f.onicecandidate!({ candidate: null });
	f.onicecandidate!({ candidate: { toJSON: () => candidate } });
	f.ondatachannel!({ channel: f.dataChannel });
	expect(f.signal).toHaveBeenCalledExactlyOnceWith({ candidate });
	expect(f.channel).toHaveBeenCalledWith(f.dataChannel);
});
test('a connection that never opens times out after 45 seconds', () => {
	const f = new PeerFixture();
	vi.advanceTimersByTime(44_999);
	expect(f.fail).not.toHaveBeenCalled();
	vi.advanceTimersByTime(1);
	expect(f.fail.mock.calls[0][0].message).toContain('接続できませんでした');
});
test('connected clears the initial deadline and a transient disconnection timer', () => {
	const f = new PeerFixture();
	f.change('disconnected');
	f.change('connected');
	vi.advanceTimersByTime(60_000);
	expect(f.fail).not.toHaveBeenCalled();
});
test('repeated disconnection events keep a single reconnect deadline', () => {
	const f = new PeerFixture();
	f.change('connected');
	f.change('disconnected');
	f.change('disconnected');
	vi.advanceTimersByTime(10_000);
	expect(f.fail).toHaveBeenCalledTimes(1);
	expect(f.fail.mock.calls[0][0].message).toContain('接続が切れました');
});
test('failed connections report failure but connecting is not a failure', () => {
	const f = new PeerFixture();
	f.change('connecting');
	expect(f.fail).not.toHaveBeenCalled();
	f.change('failed');
	expect(f.fail.mock.calls[0][0].message).toContain('回線を確認');
});
test('close cancels timers and ignores subsequent signaling and ICE events', async () => {
	const f = new PeerFixture();
	f.peer.close();
	await f.peer.receive({ candidate });
	f.onicecandidate!({ candidate: { toJSON: () => candidate } });
	vi.advanceTimersByTime(60_000);
	expect(f.addIceCandidate).not.toHaveBeenCalled();
	expect(f.signal).not.toHaveBeenCalled();
	expect(f.fail).not.toHaveBeenCalled();
});
test('an offer resolved after close cannot publish a stale description', async () => {
	const f = new PeerFixture();
	const pending = f.peer.offer(f.channel);
	f.peer.close();
	await pending;
	expect(f.signal).not.toHaveBeenCalled();
});
