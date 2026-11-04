import type { DataChannel, PeerConnection, TransferPeer } from './ports';
import type { Signal } from '../../../../shared/protocol.ts';

type Candidate = Extract<Signal, { candidate: unknown }>['candidate'];

const CONNECT_FAILED = '接続できませんでした。回線を確認して再試行してください。';
const CONNECT_TIMEOUT = '相手に接続できませんでした。インターネット接続を確認して、もう一度お試しください。';
export class PhotoPeer implements TransferPeer {
	private candidates: RTCIceCandidateInit[] = [];
	private timer: ReturnType<typeof setTimeout>;
	private disconnected?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		private pc: PeerConnection,
		private signal: (signal: Signal) => void,
		channel: (channel: DataChannel) => void,
		private fail: (error: Error) => void
	) {
		this.listen(channel);
		this.timer = setTimeout(() => fail(new Error(CONNECT_TIMEOUT)), 45_000);
	}

	private listen(channel: (channel: DataChannel) => void) {
		this.pc.onicecandidate = (e) => this.sendCandidate(e.candidate);
		this.pc.ondatachannel = (e) => channel(e.channel);
		this.pc.onconnectionstatechange = () => this.connectionChanged();
	}

	private sendCandidate(candidate: RTCIceCandidate | null) {
		if (candidate && !this.closed) {
			this.signal({ candidate: candidate.toJSON() as Candidate });
		}
	}

	private connectionChanged() {
		if (this.pc.connectionState === 'connected') {
			this.clearTimers();
		} else {
			this.connectionInterrupted(this.pc.connectionState);
		}
	}

	private connectionInterrupted(state: RTCPeerConnectionState) {
		if (state === 'failed') {
			this.fail(new Error(CONNECT_FAILED));
		}
		if (state === 'disconnected') {
			this.waitForReconnect();
		}
	}

	private waitForReconnect() {
		clearTimeout(this.disconnected);
		this.disconnected = setTimeout(() => this.fail(new Error('相手との接続が切れました。')), 10_000);
	}

	private clearTimers() {
		clearTimeout(this.timer);
		clearTimeout(this.disconnected);
	}

	private sendDescription(type: 'offer' | 'answer') {
		if (!this.closed) {
			this.signal({
				description: { type, sdp: this.pc.localDescription!.sdp }
			});
		}
	}

	async offer(channel: (channel: DataChannel) => void) {
		channel(this.pc.createDataChannel('photos', { ordered: true }));
		await this.pc.setLocalDescription(await this.pc.createOffer());
		this.sendDescription('offer');
	}

	private async receiveCandidate(candidate: Candidate) {
		if (this.pc.remoteDescription) {
			await this.pc.addIceCandidate(candidate);
		} else {
			this.candidates.push(candidate);
		}
	}

	private async receiveDescription(description: RTCSessionDescriptionInit) {
		await this.pc.setRemoteDescription(description);
		for (const candidate of this.candidates) {
			await this.pc.addIceCandidate(candidate);
		}
		this.candidates = [];
		if (description.type === 'offer') {
			await this.answer();
		}
	}

	private async answer() {
		await this.pc.setLocalDescription(await this.pc.createAnswer());
		this.sendDescription('answer');
	}

	async receive(signal: Signal) {
		if (this.closed) {
			return;
		}
		if ('candidate' in signal) {
			await this.receiveCandidate(signal.candidate);
		} else {
			await this.receiveDescription(signal.description);
		}
	}

	close() {
		this.closed = true;
		this.clearTimers();
		this.pc.onconnectionstatechange = null;
		this.pc.close();
	}
}
