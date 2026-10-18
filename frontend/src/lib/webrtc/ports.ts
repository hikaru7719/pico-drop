import type { Signal } from '../../../../shared/protocol.ts';

export interface SendChannel extends Pick<
	RTCDataChannel,
	| 'readyState'
	| 'bufferedAmount'
	| 'bufferedAmountLowThreshold'
	| 'addEventListener'
	| 'removeEventListener'
> {
	send(data: string): void;
	send(data: ArrayBuffer): void;
}

export interface DataChannel
	extends
		SendChannel,
		Pick<
			RTCDataChannel,
			'binaryType' | 'onopen' | 'onclose' | 'onerror' | 'onmessage' | 'close'
		> {}

export interface PeerConnection extends Pick<
	RTCPeerConnection,
	| 'connectionState'
	| 'onicecandidate'
	| 'ondatachannel'
	| 'onconnectionstatechange'
	| 'close'
> {
	createOffer(): Promise<RTCSessionDescriptionInit>;
	createAnswer(): Promise<RTCSessionDescriptionInit>;
	setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
	setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
	addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
	readonly localDescription: { sdp: string } | null;
	readonly remoteDescription: RTCSessionDescriptionInit | null;
	createDataChannel(label: string, options?: RTCDataChannelInit): DataChannel;
}

export interface PeerFactory {
	(config: RTCConfiguration): PeerConnection;
}

export interface TransferPeer {
	receive(signal: Signal): Promise<void>;
	close(): void;
}

export interface TransferReceiver {
	dispose(): void;
}
