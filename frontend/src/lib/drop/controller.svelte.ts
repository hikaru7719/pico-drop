import {
	ReceivedPhotos,
	releasePhoto,
	type ReceivedPhoto
} from '$lib/photos/received';
import type { PhotoAccess, ConversionMode } from '../../../../shared/photos.ts';
import { tick } from 'svelte';
import {
	LIMITS,
	type PhotoMeta,
	type ServerMessage,
	type Session
} from '../../../../shared/protocol.ts';
import { describePhotos, sharePhotos } from '$lib/photos';
import { createSession, Signaling } from '$lib/webrtc/signaling';
import type { PhotoPeer } from '$lib/webrtc/peer';
import type { PhotoReceiver } from '$lib/webrtc/transfer';
import { TransferConnection, type IceConfig } from '$lib/webrtc/connection';

type ViewCallbacks = {
	clearSelection?: () => void;
	showTransfer?: () => void;
	showReceived?: () => void;
};

// Each page owns an independent reactive controller and its resources.
// This composition scope contains the state and operations for one sharing session.
// oxlint-disable-next-line max-lines-per-function
export function createDropController(view: ViewCallbacks = {}) {
	type RequestInfo = Extract<ServerMessage, { type: 'requested' }>;
	let flowStarted = $state(false);
	let session = $state<Session>();
	let connection = $state<'idle' | 'connecting' | 'online' | 'offline'>('idle');
	let incomingToken = $state('');
	let shareLink = $state('');
	let linkExpiresAt = $state<number>();
	let creatingLink = $state(false);
	let linkTimer: ReturnType<typeof setTimeout> | undefined;
	let selected = $state<File[]>([]);
	let metadata = $state<PhotoMeta[]>([]);
	let selecting = $state(false);
	let request = $state<RequestInfo>();
	let phase = $state<'waiting' | 'connecting' | 'transferring'>('waiting');
	let bytes = $state(0);
	let received = $state<ReceivedPhoto[]>([]);
	let photoCollection: ReceivedPhotos | undefined;
	let photosExpireAt = $state<number>();
	let completed = $state(false);
	let notice = $state('');
	let error = $state('');
	let relay = $state<boolean>();
	let sharing = $state(false);
	let signaling: Signaling | undefined;
	let sessionAbort: AbortController | undefined;
	let peer: PhotoPeer | undefined;
	let receiver: PhotoReceiver | undefined;
	let abort = new AbortController();
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let signalQueue = Promise.resolve();
	let disposed = false;
	const sending = $derived(!!request && request.from.id === session?.id);
	const total = $derived(
		request?.files.reduce((sum, f) => sum + f.size, 0) ?? 0
	);

	const TRANSFER_STOPPED =
		'転送が止まりました。画面を開いたまま再試行してください。';
	const CONFIRM_EXPIRED =
		'受け取るかどうかを確認する時間が過ぎました。新しい共有リンクで送り直してください。';
	const RECEIVED_NOTICE =
		'写真を受け取りました。保存するには、下のボタンを押してください。';
	const SENT_NOTICE =
		'すべての写真が相手の端末に届きました。元の写真と同じデータであることも確認できました。';
	const PREVIOUS_PHOTOS =
		'前に受け取った写真がこの画面に残っているため、新しい写真は受け取りませんでした。保存できたことを確認して、画面内の写真を削除してください。';
	const REJECTED_NOTICE = '写真の受け取りを断りました。';
	const endMessages = {
		rejected: '相手が写真を受け取りませんでした。',
		cancelled: '転送を中止しました。',
		disconnected: '相手との接続が切れました。再試行してください。',
		timeout: '有効期限が切れました。もう一度送信してください。'
	};
	const shareMessages = {
		shared:
			'保存・共有の画面を閉じました。写真を保存した場合は、写真アプリなどで確認してください。',
		cancelled: '共有をキャンセルしました。写真はこの画面に残っています。',
		unsupported:
			'このブラウザでは写真を共有できません。写真のファイル名を押して、1枚ずつダウンロードしてください。'
	};
	function discard() {
		photoCollection?.dispose();
		photoCollection = undefined;
		photosExpireAt = undefined;
		for (const item of received) {
			releasePhoto(item);
		}
		received = [];
		completed = false;
	}
	function closePeer() {
		abort.abort();
		peer?.close();
		peer = undefined;
		receiver?.dispose();
		receiver = undefined;
	}
	function cleanupTransfer() {
		closePeer();
		clearTimeout(watchdog);
		request = undefined;
	}
	function closeSignaling() {
		generation++;
		sessionAbort?.abort();
		sessionAbort = undefined;
		signaling?.close();
		signaling = undefined;
	}
	function resetLink() {
		clearTimeout(linkTimer);
		shareLink = '';
		linkExpiresAt = undefined;
		creatingLink = false;
	}
	function disconnect(state: 'idle' | 'offline' = 'idle') {
		closeSignaling();
		cleanupTransfer();
		resetLink();
		session = undefined;
		connection = state;
	}
	function send(message: Parameters<Signaling['send']>[0]) {
		if (!signaling) {
			throw new Error('再接続してください。');
		}
		signaling.send(message);
	}
	function cancelRequest() {
		if (!request) {
			return;
		}
		try {
			send({ type: 'cancel', id: request.id });
		} catch {
			/* Already disconnected. */
		}
	}
	function fail(cause: unknown) {
		error = errorMessage(cause);
		cancelRequest();
		disconnect('offline');
		retainOrDiscard();
	}
	function retainOrDiscard() {
		if (!completed) {
			discard();
		} else if (received.length && !photoCollection) {
			retainPhotos();
		}
	}
	function errorMessage(cause: unknown) {
		return cause instanceof Error
			? cause.message
			: '処理に失敗しました。再試行してください。';
	}

	function touch() {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => fail(new Error(TRANSFER_STOPPED)), 60_000);
	}
	function prepareConnection() {
		disconnect();
		error = '';
		notice = '';
		connection = 'connecting';
		creatingLink = !incomingToken;
		sessionAbort = new AbortController();
	}
	function activeGeneration(current: number) {
		return !disposed && current === generation;
	}
	function signalFailure(e: unknown, current: number) {
		if (
			activeGeneration(current) &&
			!(e instanceof Error && e.name === 'AbortError')
		) {
			fail(e);
		}
	}
	function queueSignal(message: ServerMessage, current: number) {
		signalQueue = signalQueue
			.then(async () => {
				if (activeGeneration(current)) {
					await handle(message);
				}
			})
			.catch((e) => signalFailure(e, current));
	}
	function connectionClosed(current: number) {
		if (activeGeneration(current)) {
			fail(
				new Error('接続が切れました。新しい共有リンクで再試行してください。')
			);
		}
	}
	function checkBrowser() {
		if (!window.isSecureContext || !window.RTCPeerConnection) {
			throw new Error(
				'このブラウザでは写真を転送できません。SafariやChromeで、https://から始まるリンクを開いてください。'
			);
		}
	}
	function openSignaling(next: Session, current: number) {
		session = next;
		signaling = new Signaling(
			next,
			(message) => queueSignal(message, current),
			() => connectionClosed(current)
		);
	}
	async function openSession(current: number) {
		checkBrowser();
		const next = await createSession(sessionAbort!.signal, incomingToken);
		if (activeGeneration(current)) {
			openSignaling(next, current);
		}
	}

	async function attemptConnection(current: number) {
		try {
			await openSession(current);
		} catch (e) {
			if (current === generation) {
				fail(e);
			}
		}
	}
	async function connect() {
		if (disposed || connection === 'connecting') {
			return;
		}
		prepareConnection();
		await attemptConnection(generation);
	}

	async function createLink() {
		if (creatingLink || selecting || !metadata.length || request || shareLink) {
			return;
		}
		flowStarted = true;
		creatingLink = true;
		await connect();
		creatingLink = connection === 'connecting';
	}

	function canJoinLink() {
		return (
			connection !== 'connecting' &&
			!request &&
			!!incomingToken &&
			!(completed && received.length)
		);
	}

	async function joinLink() {
		if (!canJoinLink()) {
			return;
		}
		flowStarted = true;
		await connect();
	}

	function revokeLink() {
		disconnect();
		notice = '共有リンクを取り消しました。';
	}

	function linkExpired() {
		disconnect();
		error = '共有リンクの有効期限が切れました。新しく作成してください。';
	}

	function linkCreated(
		message: Extract<ServerMessage, { type: 'link-created' }>
	) {
		clearTimeout(watchdog);
		shareLink = `${window.location.origin}/#share=${message.token}`;
		linkExpiresAt = message.expiresAt;
		creatingLink = false;
		scheduleLinkExpiry(message.expiresAt);
	}

	function scheduleLinkExpiry(expiresAt: number) {
		clearTimeout(linkTimer);
		linkTimer = setTimeout(linkExpired, Math.max(0, expiresAt - Date.now()));
	}

	async function shareInvitation() {
		try {
			await publishInvitation();
		} catch (e) {
			if (!(e instanceof Error && e.name === 'AbortError')) {
				error = '共有できませんでした。リンクをコピーして送ってください。';
			}
		}
	}

	async function publishInvitation() {
		if (navigator.share) {
			await navigator.share(invitationData());
		} else {
			await copyInvitation();
		}
	}

	function invitationData() {
		return {
			title: 'Pico Drop',
			text: '写真の共有リンク（10分間有効）',
			url: shareLink
		};
	}

	async function copyInvitation() {
		try {
			await navigator.clipboard.writeText(shareLink);
			notice = 'リンクをコピーしました。LINEなどで相手に送ってください。';
		} catch {
			error =
				'コピーできませんでした。表示されたリンクを選択してコピーしてください。';
		}
	}

	async function describeSelection(files: File[]) {
		const result = await describePhotos(files);
		selected = files;
		metadata = result;
	}
	function selectionFailed(e: unknown) {
		selected = [];
		metadata = [];
		error = e instanceof Error ? e.message : '写真を選び直してください。';
	}
	async function selectFiles(files: File[]) {
		try {
			await describeSelection(files);
		} catch (e) {
			selectionFailed(e);
		} finally {
			selecting = false;
		}
	}
	async function select(files: File[]) {
		if (shareLink || creatingLink || request) {
			return;
		}
		selecting = true;
		error = '';
		await selectFiles(files);
	}

	function finishAction(type: 'accept' | 'reject' | 'cancel') {
		if (type === 'accept') {
			phase = 'connecting';
			return;
		}
		disconnect();
		discard();
		notice = type === 'reject' ? REJECTED_NOTICE : '転送を中止しました。';
	}
	function sendAction(type: 'accept' | 'reject' | 'cancel', id: string) {
		try {
			send({ type, id });
			finishAction(type);
		} catch (e) {
			fail(e);
		}
	}
	function action(type: 'accept' | 'reject' | 'cancel') {
		if (request) {
			sendAction(type, request.id);
		}
	}

	function ready() {
		connection = 'online';
		startControlTimer();
		if (incomingToken) {
			send({ type: 'join-link', token: incomingToken });
		} else {
			send({ type: 'create-link', files: metadata });
		}
	}
	function startControlTimer() {
		watchdog = setTimeout(controlTimedOut, 10_000);
	}
	function controlTimedOut() {
		fail(
			new Error(
				'共有リンクの準備に時間がかかっています。もう一度お試しください。'
			)
		);
	}

	function serverError(message: string) {
		resetLink();
		if (request) {
			fail(new Error(message));
		} else {
			error = message;
			disconnect('offline');
		}
	}
	function declineWhileUnsaved(message: RequestInfo) {
		if (!completed || !received.length || message.to.id !== session?.id) {
			return false;
		}
		send({ type: 'reject', id: message.id });
		notice = PREVIOUS_PHOTOS;
		return true;
	}
	function resetRequest(message: RequestInfo) {
		clearTimeout(watchdog);
		resetLink();
		discard();
		request = message;
		bytes = 0;
		phase = 'waiting';
	}
	function waitForApproval() {
		error = '';
		notice = '';
		relay = undefined;
		watchdog = setTimeout(
			() => fail(new Error(CONFIRM_EXPIRED)),
			LIMITS.requestMs + 1000
		);
	}
	async function requested(message: RequestInfo) {
		if (declineWhileUnsaved(message)) {
			return;
		}
		resetRequest(message);
		waitForApproval();
		await tick();
		view.showTransfer?.();
	}

	function transferOutcome(
		reason: Extract<ServerMessage, { type: 'ended' }>['reason']
	) {
		if (reason === 'complete') {
			completed = true;
			notice = sending ? SENT_NOTICE : RECEIVED_NOTICE;
		} else {
			failedOutcome(reason);
		}
	}
	function failedOutcome(reason: keyof typeof endMessages) {
		error = endMessages[reason];
		discard();
	}

	type EndReason = Extract<ServerMessage, { type: 'ended' }>['reason'];
	async function ended(reason: EndReason, access?: PhotoAccess) {
		transferOutcome(reason);
		if (reason === 'complete' && received.length) {
			retainPhotos(access);
		}
		disconnect();
		return showReceived();
	}
	async function showReceived() {
		if (completed && received.length) {
			await tick();
			view.showReceived?.();
		}
	}

	async function beginTransfer() {
		phase = 'connecting';
		touch();
		await start();
	}
	async function applyTransferMessage(
		message: Extract<ServerMessage, { id: string }>
	) {
		if (message.type === 'start') {
			return beginTransfer();
		}
		return forwardTransferMessage(message);
	}
	async function forwardTransferMessage(
		message: Extract<ServerMessage, { id: string }>
	) {
		if (message.type === 'signal') {
			return peer?.receive(message.signal);
		}
		if (message.type === 'ended') {
			return ended(message.reason, message.photoAccess);
		}
	}

	async function handleTransfer(
		message: Extract<ServerMessage, { id: string }>
	) {
		if (request && message.id === request.id) {
			await applyTransferMessage(message);
		}
	}

	async function handle(message: ServerMessage) {
		if (message.type === 'ready') {
			return ready();
		}
		if (message.type === 'link-created') {
			return linkCreated(message);
		}
		return handleLinkMessage(message);
	}
	async function handleLinkMessage(
		message: Exclude<ServerMessage, { type: 'ready' | 'link-created' }>
	) {
		if (message.type === 'link-ended') {
			return shareLink ? linkExpired() : resetLink();
		}
		return handleRequestMessage(message);
	}
	type RequestMessage = Exclude<
		ServerMessage,
		{ type: 'ready' | 'link-created' | 'link-ended' }
	>;
	async function handleRequestMessage(message: RequestMessage) {
		if (message.type === 'error') {
			return serverError(message.message);
		}
		if (message.type === 'requested') {
			return requested(message);
		}
		return handleTransfer(message);
	}

	async function fetchIce(signal: AbortSignal) {
		const response = await fetch('/api/ice', {
			method: 'POST',
			headers: { Authorization: `Bearer ${session!.token}` },
			signal
		});
		const config = (await response.json()) as IceConfig;
		return { response, config };
	}
	function updateProgress(n: number) {
		bytes = n;
		touch();
	}
	function receivedPhoto(file: File) {
		const preview = !['image/heic', 'image/heif'].includes(file.type);
		const id = request?.files[received.length]?.id;
		received = [
			...received,
			{ file, id, url: URL.createObjectURL(file), preview }
		];
	}
	function checkIce(response: Response, config: IceConfig) {
		if (!response.ok) {
			throw new Error(config.error ?? '接続の準備に失敗しました。');
		}
		relay = config.relay;
	}

	// Keep the transport independent of Svelte and page lifecycle.
	// oxlint-disable-next-line max-lines-per-function
	function transferCallbacks() {
		return {
			files: selected,
			total,
			bytes: () => bytes,
			completed: () => completed,
			open: () => {
				phase = 'transferring';
			},
			complete: () => {
				completed = true;
			},
			touch,
			fail,
			send,
			progress: updateProgress,
			received: receivedPhoto,
			peer: (next: PhotoPeer) => {
				peer = next;
			},
			receiver: (next: PhotoReceiver) => {
				receiver = next;
			}
		};
	}
	async function connectTransfer(
		transfer: RequestInfo,
		signal: AbortSignal,
		config: IceConfig
	) {
		const sender = transfer.from.id === session!.id;
		const cb = transferCallbacks();
		const link = new TransferConnection(transfer, signal, sender, cb);
		await link.connect(config);
	}
	async function prepareTransfer(transfer: RequestInfo, signal: AbortSignal) {
		const { response, config } = await fetchIce(signal);
		if (signal.aborted || request?.id !== transfer.id) {
			return;
		}
		checkIce(response, config);
		await connectTransfer(transfer, signal, config);
	}

	async function start() {
		const transfer = request;
		if (!transfer || !session) {
			return;
		}
		abort = new AbortController();
		await prepareTransfer(transfer, abort.signal);
	}
	async function shareReceived() {
		const result = await sharePhotos(received.map((item) => item.file));
		notice = shareMessages[result];
	}
	async function tryShare() {
		try {
			await shareReceived();
		} catch {
			error = '共有できませんでした。各写真のダウンロードをお試しください。';
		} finally {
			sharing = false;
		}
	}
	async function save() {
		if (!photoCollection?.checkExpiry()) {
			return;
		}
		sharing = true;
		error = '';
		await tryShare();
	}

	function photosExpired() {
		completed = false;
		photosExpireAt = undefined;
		notice =
			'受信から10分たったため、画面内の写真を削除しました。端末に保存した写真は残っています。';
	}
	function retainPhotos(access?: PhotoAccess) {
		photoCollection = new ReceivedPhotos(received, access, {
			changed: updateReceived,
			expired: photosExpired
		});
		photosExpireAt = photoCollection.expiresAt;
	}
	function updateReceived(photos: ReceivedPhoto[]) {
		received = photos;
	}
	function checkPhotoExpiry() {
		return photoCollection?.checkExpiry() ?? false;
	}
	async function convertPhoto(index: number, mode: ConversionMode) {
		await photoCollection?.convert(index, mode);
	}
	async function shareJpeg(index: number) {
		if (!photoCollection?.checkExpiry()) {
			return;
		}
		const jpeg = received[index]?.jpeg;
		if (jpeg) {
			await shareConverted(jpeg);
		}
	}
	async function shareConverted(jpeg: File) {
		try {
			notice = shareMessages[await sharePhotos([jpeg])];
		} catch {
			error = '共有できませんでした。JPEGをダウンロードしてください。';
		}
	}
	function leave() {
		selected = [];
		metadata = [];
		view.clearSelection?.();
		disposed = true;
		disconnect();
		discard();
	}
	function resume(e: PageTransitionEvent) {
		checkPhotoExpiry();
		if (e.persisted) {
			disposed = false;
		}
	}
	function unmount() {
		leave();
		window.removeEventListener('hashchange', readInvitation);
		window.removeEventListener('pagehide', leave);
		window.removeEventListener('pageshow', resume);
		window.removeEventListener('focus', checkPhotoExpiry);
		window.removeEventListener('visibilitychange', checkPhotoExpiry);
	}
	function readInvitation() {
		const params = new URLSearchParams(window.location.hash.slice(1));
		const token = params.get('share');
		incomingToken = '';
		if (token !== null) {
			applyInvitation(token);
		}
	}

	function applyInvitation(token: string) {
		if (/^[a-f0-9]{64}$/.test(token)) {
			incomingToken = token;
			flowStarted = true;
			void joinLink();
		} else {
			error =
				'共有リンクが正しくありません。送信者に作り直してもらってください。';
		}
	}

	function mount() {
		readInvitation();
		window.addEventListener('hashchange', readInvitation);
		window.addEventListener('pagehide', leave);
		window.addEventListener('pageshow', resume);
		window.addEventListener('focus', checkPhotoExpiry);
		window.addEventListener('visibilitychange', checkPhotoExpiry);
		return unmount;
	}
	function removePhoto(index: number) {
		if (shareLink || creatingLink || selecting || request) {
			return;
		}
		selected = selected.filter((_, i) => i !== index);
		metadata = metadata.filter((_, i) => i !== index);
		view.clearSelection?.();
	}
	function previewFailed(index: number) {
		const photo = received[index];
		if (photo) {
			photo.preview = false;
		}
	}

	return {
		get flowStarted() {
			return flowStarted;
		},
		get session() {
			return session;
		},
		get connection() {
			return connection;
		},
		get selected() {
			return selected;
		},
		get metadata() {
			return metadata;
		},
		get selecting() {
			return selecting;
		},
		get request() {
			return request;
		},
		get phase() {
			return phase;
		},
		get bytes() {
			return bytes;
		},
		get received() {
			return received;
		},
		get completed() {
			return completed;
		},
		get notice() {
			return notice;
		},
		get error() {
			return error;
		},
		get relay() {
			return relay;
		},
		get sharing() {
			return sharing;
		},
		get incomingToken() {
			return incomingToken;
		},
		get shareLink() {
			return shareLink;
		},
		get linkExpiresAt() {
			return linkExpiresAt;
		},
		get creatingLink() {
			return creatingLink;
		},
		get photosExpireAt() {
			return photosExpireAt;
		},
		mount,
		createLink,
		joinLink,
		revokeLink,
		shareInvitation,
		copyInvitation,
		select,
		action,
		save,
		discard,
		convertPhoto,
		shareJpeg,
		checkPhotoExpiry,
		removePhoto,
		previewFailed
	};
}
