import type { Signal } from '../../../../shared/protocol.ts';
export class PhotoPeer {
	private pc: RTCPeerConnection;
	private candidates: RTCIceCandidateInit[] = [];
	private timer: ReturnType<typeof setTimeout>;
	private disconnected?: ReturnType<typeof setTimeout>;
	private closed = false;
	constructor(
		iceServers: RTCIceServer[],
		private signal: (signal: Signal) => void,
		channel: (channel: RTCDataChannel) => void,
		private fail: (error: Error) => void
	) {
		this.pc = new RTCPeerConnection({ iceServers });
		this.pc.onicecandidate = (e) => {
			if (e.candidate && !this.closed)
				signal({
					candidate: e.candidate.toJSON() as Extract<
						Signal,
						{ candidate: unknown }
					>['candidate']
				});
		};
		this.pc.ondatachannel = (e) => channel(e.channel);
		this.pc.onconnectionstatechange = () => {
			const state = this.pc.connectionState;
			if (state === 'connected') {
				clearTimeout(this.timer);
				clearTimeout(this.disconnected);
			}
			if (state === 'failed')
				fail(
					new Error('接続できませんでした。回線を確認して再試行してください。')
				);
			if (state === 'disconnected')
				this.disconnected = setTimeout(
					() => fail(new Error('相手との接続が切れました。')),
					10_000
				);
		};
		this.timer = setTimeout(
			() =>
				fail(
					new Error(
						'接続がタイムアウトしました。中継設定または回線を確認してください。'
					)
				),
			45_000
		);
	}
	async offer(channel: (channel: RTCDataChannel) => void) {
		channel(this.pc.createDataChannel('photos', { ordered: true }));
		await this.pc.setLocalDescription(await this.pc.createOffer());
		if (!this.closed)
			this.signal({
				description: { type: 'offer', sdp: this.pc.localDescription!.sdp }
			});
	}
	async receive(signal: Signal) {
		if (this.closed) return;
		if ('candidate' in signal) {
			if (this.pc.remoteDescription)
				await this.pc.addIceCandidate(signal.candidate);
			else this.candidates.push(signal.candidate);
			return;
		}
		await this.pc.setRemoteDescription(signal.description);
		for (const candidate of this.candidates)
			await this.pc.addIceCandidate(candidate);
		this.candidates = [];
		if (signal.description.type === 'offer') {
			await this.pc.setLocalDescription(await this.pc.createAnswer());
			if (!this.closed)
				this.signal({
					description: { type: 'answer', sdp: this.pc.localDescription!.sdp }
				});
		}
	}
	close() {
		this.closed = true;
		clearTimeout(this.timer);
		clearTimeout(this.disconnected);
		this.pc.onconnectionstatechange = null;
		this.pc.close();
	}
}
