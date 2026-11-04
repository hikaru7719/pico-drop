import { createApi } from '#lib/api.ts';
import { Invitations } from './invitations.svelte.ts';
import { ReceivedPhotoActions } from './received-photos.svelte.ts';
import type { PhotoAccess, ConversionMode } from '../../../../shared/photos.ts';
import { tick } from 'svelte';
import { LIMITS, type GroupParticipant, type PhotoMeta, type ServerMessage, type Session } from '../../../../shared/protocol.ts';
import { describePhotos, sharePhotos } from '#lib/photos/index.ts';
import { createSession, Signaling, type SignalingConnection } from '#lib/webrtc/signaling.ts';
import type { TransferPeer, TransferReceiver } from '#lib/webrtc/ports.ts';
import { createTransferConnection, type TransferFactory, type IceConfig } from '#lib/webrtc/connection.ts';

type ViewCallbacks = {
	clearSelection?: () => void;
	showTransfer?: () => void;
	showReceived?: () => void;
};

export interface DropDependencies {
	createSession(signal: AbortSignal, token: string): Promise<Session>;
	createSignaling(session: Session, message: (message: ServerMessage) => void, closed: () => void): SignalingConnection;
	createTransfer: TransferFactory;
	describePhotos: typeof describePhotos;
	sharePhotos: typeof sharePhotos;
	fetch: typeof fetch;
}

const browserDependencies: DropDependencies = {
	createSession,
	createSignaling: (...args) => new Signaling(...args),
	createTransfer: createTransferConnection,
	describePhotos,
	sharePhotos,
	fetch: (...args) => fetch(...args)
};

// Each page owns an independent reactive controller and its resources.
// This composition scope contains the state and operations for one sharing session.
// oxlint-disable-next-line max-lines-per-function
export function createDropController(view: ViewCallbacks = {}, dependencies: DropDependencies = browserDependencies) {
	type RequestInfo = Extract<ServerMessage, { type: 'requested' }>;

	let groupMode = $state(false);
	let groupReceiver = $state(false);
	let participants = $state<GroupParticipant[]>([]);
	let flowStarted = $state(false);
	let session = $state<Session>();
	let connection = $state<'idle' | 'connecting' | 'online' | 'offline'>('idle');
	let creatingLink = $state(false);
	let selected = $state<File[]>([]);
	let metadata = $state<PhotoMeta[]>([]);
	let selecting = $state(false);
	let request = $state<RequestInfo>();
	let phase = $state<'waiting' | 'queued' | 'connecting' | 'transferring'>('waiting');
	let bytes = $state(0);
	let completed = $state(false);
	let notice = $state('');
	let error = $state('');
	let relay = $state<boolean>();
	let signaling: SignalingConnection | undefined;
	let sessionAbort: AbortController | undefined;
	let peer: TransferPeer | undefined;
	let receiver: TransferReceiver | undefined;
	let abort = new AbortController();
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let signalQueue = Promise.resolve();
	let disposed = false;
	const total = $derived(request?.files.reduce((sum, f) => sum + f.size, 0) ?? 0);

	const messages = {
		notice(message: string) {
			notice = message;
		},
		error(message: string) {
			error = message;
		}
	};
	const invitation = new Invitations({
		...messages,
		expired: linkExpired,
		join() {
			flowStarted = true;
			void joinLink();
		}
	});
	const photos = new ReceivedPhotoActions(dependencies.sharePhotos, {
		...messages,
		cleared() {
			completed = false;
		}
	});

	const TRANSFER_STOPPED = '転送が止まりました。画面を開いたまま再試行してください。';
	const CONFIRM_EXPIRED = '受け取るかどうかを確認する時間が過ぎました。新しい共有リンクで送り直してください。';
	const PREVIOUS_PHOTOS =
		'前に受け取った写真がこの画面に残っているため、新しい写真は受け取りませんでした。保存できたことを確認して、画面内の写真を削除してください。';
	const REJECTED_NOTICE = '写真の受け取りを断りました。';
	const endMessages = {
		failed: '写真の転送に失敗しました。再試行してください。',
		rejected: '相手が写真を受け取りませんでした。',
		cancelled: '転送を中止しました。',
		disconnected: '相手との接続が切れました。再試行してください。',
		timeout: '有効期限が切れました。もう一度送信してください。'
	};

	function restartSharing(keepPhotos: boolean) {
		completed = false;
		error = '';
		notice = '';
		if (keepPhotos) {
			void createLink();
		} else {
			clearSelection();
		}
	}

	function clearSelection() {
		selected = [];
		metadata = [];
		view.clearSelection?.();
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
		invitation.reset();
		creatingLink = false;
	}

	function disconnect(state: 'idle' | 'offline' = 'idle') {
		closeSignaling();
		cleanupTransfer();
		resetLink();
		session = undefined;
		connection = state;
		if (state === 'offline') {
			stopGroupView();
		}
	}

	function send(message: Parameters<SignalingConnection['send']>[0]) {
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
		if (request?.group && connection === 'online') {
			return failGroupTransfer(cause);
		}
		error = errorMessage(cause);
		cancelRequest();
		disconnect('offline');
		retainOrDiscard();
	}

	function failGroupTransfer(cause: unknown) {
		error = errorMessage(cause);
		try {
			send({ type: 'fail', id: request!.id });
		} catch {
			disconnect('offline');
		}
		cleanupTransfer();
		photos.clear();
	}

	function retainOrDiscard() {
		if (!completed) {
			photos.clear();
		} else if (photos.items.length && !photos.retained) {
			photos.retain();
		}
	}

	function errorMessage(cause: unknown) {
		return cause instanceof Error ? cause.message : '処理に失敗しました。再試行してください。';
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
		creatingLink = !invitation.token;
		sessionAbort = new AbortController();
	}

	function activeGeneration(current: number) {
		return !disposed && current === generation;
	}

	function signalFailure(e: unknown, current: number) {
		if (activeGeneration(current) && !(e instanceof Error && e.name === 'AbortError')) {
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
			disconnect('offline');
			fail(new Error('接続が切れました。新しい共有リンクで再試行してください。'));
		}
	}

	function checkBrowser() {
		if (!window.isSecureContext || !window.RTCPeerConnection) {
			throw new Error('このブラウザでは写真を転送できません。SafariやChromeで、https://から始まるリンクを開いてください。');
		}
	}

	function openSignaling(next: Session, current: number) {
		session = next;
		signaling = dependencies.createSignaling(
			next,
			(message) => queueSignal(message, current),
			() => connectionClosed(current)
		);
	}

	async function openSession(current: number) {
		checkBrowser();
		const next = await dependencies.createSession(sessionAbort!.signal, invitation.token);
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

	async function createLink(mode: 'single' | 'group' = 'single') {
		if (creatingLink || selecting || !metadata.length || request || invitation.link) {
			return;
		}
		prepareGroup(mode);
		await connect();
		creatingLink = connection === 'connecting';
	}

	function prepareGroup(mode: 'single' | 'group') {
		groupMode = mode === 'group';
		participants = [];
		flowStarted = true;
		creatingLink = true;
	}

	function canJoinLink() {
		return (
			connection !== 'connecting' && !request && !!invitation.token && !invitation.used && !(completed && photos.items.length)
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
		stopGroupView();
		disconnect();
		notice = '共有リンクを取り消しました。';
	}

	function linkExpired() {
		stopGroupView();
		disconnect();
		error = '共有リンクの有効期限が切れました。新しく作成してください。';
	}

	function stopGroupView() {
		if (!groupMode) {
			return;
		}
		participants = participants.map(stoppedParticipant);
		completed = false;
	}

	function stoppedParticipant(p: GroupParticipant): GroupParticipant {
		return ['waiting', 'queued', 'transferring'].includes(p.status) ? { ...p, status: 'declined' } : p;
	}

	function groupAction(type: 'approve' | 'cancel', id: string) {
		try {
			send({ type, id });
		} catch (e) {
			fail(e);
		}
	}

	function canRetryGroup() {
		return groupReceiver && !request && !photos.items.length && connection === 'online';
	}

	function retryGroup() {
		if (!canRetryGroup()) {
			return;
		}
		error = '';
		send({ type: 'join-link', token: invitation.token });
	}

	function linkCreated(message: Extract<ServerMessage, { type: 'link-created' }>) {
		clearTimeout(watchdog);
		invitation.created(message.token, message.expiresAt);
		creatingLink = false;
	}

	async function describeSelection(files: File[]) {
		const result = await dependencies.describePhotos(files);
		selected = files;
		metadata = result;
	}

	function selectionFailed(e: unknown) {
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
		if (invitation.link || creatingLink || selecting || request) {
			return;
		}
		selecting = true;
		error = '';
		notice = '';
		await selectFiles(files);
		view.clearSelection?.();
	}

	async function addPhotos(files: File[]) {
		if (files.length) {
			await select([...selected, ...files]);
		}
	}

	function finishAction(type: 'accept' | 'reject' | 'cancel') {
		if (type === 'accept') {
			phase = request?.group ? 'queued' : 'connecting';
			return;
		}
		finishCancellation(type);
	}

	function finishCancellation(type: 'reject' | 'cancel') {
		if (groupMode && invitation.link) {
			return;
		}
		disconnect();
		photos.clear();
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
		if (invitation.token) {
			send({ type: 'join-link', token: invitation.token });
		} else {
			sendCreateLink();
		}
	}

	function sendCreateLink() {
		send({
			type: 'create-link',
			files: metadata,
			...(groupMode ? { mode: 'group' as const } : {})
		});
	}

	function startControlTimer() {
		watchdog = setTimeout(controlTimedOut, 10_000);
	}

	function controlTimedOut() {
		fail(new Error('共有リンクの準備に時間がかかっています。もう一度お試しください。'));
	}

	function serverError(message: string) {
		if (groupMode && invitation.link) {
			error = message;
			return;
		}
		failServerRequest(message);
	}

	function failServerRequest(message: string) {
		resetLink();
		if (request) {
			fail(new Error(message));
		} else {
			error = message;
			disconnect('offline');
		}
	}

	function declineWhileUnsaved(message: RequestInfo) {
		if (!completed || !photos.items.length || message.to.id !== session?.id) {
			return false;
		}
		send({ type: 'reject', id: message.id });
		notice = PREVIOUS_PHOTOS;
		return true;
	}

	function resetRequest(message: RequestInfo) {
		clearTimeout(watchdog);
		if (!groupMode) {
			resetLink();
		}
		initializeRequest(message);
	}

	function initializeRequest(message: RequestInfo) {
		groupReceiver = !!message.group && message.to.id === session?.id;
		photos.clear();
		invitation.used = !!invitation.token;
		request = message;
		bytes = 0;
		phase = 'waiting';
	}

	function waitForApproval(message: RequestInfo) {
		error = '';
		notice = '';
		relay = undefined;
		watchdog = setTimeout(() => fail(new Error(CONFIRM_EXPIRED)), approvalTimeout(message));
	}

	function approvalTimeout(message: RequestInfo) {
		return (message.group ? Math.max(0, (message.expiresAt ?? Date.now()) - Date.now()) : LIMITS.requestMs) + 1000;
	}

	async function requested(message: RequestInfo) {
		if (declineWhileUnsaved(message)) {
			return;
		}
		resetRequest(message);
		waitForApproval(message);
		await showRequested();
	}

	async function showRequested() {
		await tick();
		if (!groupMode) {
			view.showTransfer?.();
		}
	}

	function transferOutcome(reason: Extract<ServerMessage, { type: 'ended' }>['reason']) {
		if (reason === 'complete') {
			completed = true;
			notice = '';
		} else {
			failedOutcome(reason);
		}
	}

	function failedOutcome(reason: keyof typeof endMessages) {
		error = endMessages[reason];
		photos.clear();
	}

	type EndReason = Extract<ServerMessage, { type: 'ended' }>['reason'];

	async function ended(reason: EndReason, access?: PhotoAccess) {
		if ((groupMode && invitation.link) || (groupReceiver && reason === 'failed')) {
			return groupEnded(reason);
		}
		return finishSingleTransfer(reason, access);
	}

	async function finishSingleTransfer(reason: EndReason, access?: PhotoAccess) {
		transferOutcome(reason);
		if (reason === 'complete' && photos.items.length) {
			photos.retain(access);
		}
		disconnect();
		return showReceived();
	}

	function groupEnded(reason: EndReason) {
		cleanupTransfer();
		photos.clear();
		if (reason !== 'complete') {
			error = endMessages[reason];
		}
	}

	async function showReceived() {
		if (completed && photos.items.length) {
			await tick();
			view.showReceived?.();
		}
	}

	async function beginTransfer() {
		phase = 'connecting';
		touch();
		await start();
	}

	async function applyTransferMessage(message: Extract<ServerMessage, { id: string }>) {
		if (message.type === 'start') {
			return beginTransfer();
		}
		return forwardTransferMessage(message);
	}

	async function forwardTransferMessage(message: Extract<ServerMessage, { id: string }>) {
		if (message.type === 'signal') {
			return peer?.receive(message.signal);
		}
		if (message.type === 'ended') {
			return ended(message.reason, message.photoAccess);
		}
	}

	async function handleTransfer(message: Extract<ServerMessage, { id: string }>) {
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

	async function handleLinkMessage(message: Exclude<ServerMessage, { type: 'ready' | 'link-created' }>) {
		if (message.type === 'group-state') {
			participants = message.participants;
			return;
		}
		return handleLinkEnd(message);
	}

	type LinkEndMessage = Exclude<ServerMessage, { type: 'ready' | 'link-created' | 'group-state' }>;

	async function handleLinkEnd(message: LinkEndMessage) {
		if (message.type === 'link-ended') {
			return invitation.link ? linkExpired() : resetLink();
		}
		return handleRequestMessage(message);
	}

	type RequestMessage = Exclude<ServerMessage, { type: 'ready' | 'link-created' | 'link-ended' | 'group-state' }>;

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
		const response = await createApi(dependencies.fetch).ice.$post(undefined, {
			headers: { Authorization: `Bearer ${session!.token}` },
			init: { signal }
		});
		const config = (await response.json()) as IceConfig;
		return { response, config };
	}

	function updateProgress(n: number) {
		bytes = n;
		touch();
	}

	function receivedPhoto(file: File) {
		photos.add(file, request?.files[photos.items.length]?.id);
	}

	function checkIce(response: { ok: boolean }, config: IceConfig) {
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
			peer: (next: TransferPeer) => {
				peer = next;
			},
			receiver: (next: TransferReceiver) => {
				receiver = next;
			}
		};
	}

	async function connectTransfer(transfer: RequestInfo, signal: AbortSignal, config: IceConfig) {
		const sender = transfer.from.id === session!.id;
		const cb = transferCallbacks();
		const link = dependencies.createTransfer(transfer, signal, sender, cb);
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

	function checkPhotoExpiry() {
		return photos.checkExpiry();
	}

	function leave() {
		selected = [];
		metadata = [];
		view.clearSelection?.();
		disposed = true;
		disconnect();
		photos.clear();
	}

	function resume(e: PageTransitionEvent) {
		checkPhotoExpiry();
		if (e.persisted) {
			disposed = false;
		}
	}

	function unmount() {
		leave();
		window.removeEventListener('hashchange', invitation.read);
		window.removeEventListener('pagehide', leave);
		window.removeEventListener('pageshow', resume);
		window.removeEventListener('focus', checkPhotoExpiry);
		window.removeEventListener('visibilitychange', checkPhotoExpiry);
	}

	function mount() {
		invitation.read();
		window.addEventListener('hashchange', invitation.read);
		window.addEventListener('pagehide', leave);
		window.addEventListener('pageshow', resume);
		window.addEventListener('focus', checkPhotoExpiry);
		window.addEventListener('visibilitychange', checkPhotoExpiry);
		return unmount;
	}

	function removePhoto(index: number) {
		if (invitation.link || creatingLink || selecting || request) {
			return;
		}
		selected = selected.filter((_, i) => i !== index);
		metadata = metadata.filter((_, i) => i !== index);
		view.clearSelection?.();
	}

	return {
		get groupMode() {
			return groupMode;
		},
		get participants() {
			return participants;
		},
		get groupReceiver() {
			return groupReceiver;
		},
		groupAction,
		retryGroup,
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
			return photos.items;
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
			return photos.sharing;
		},
		get invitationUsed() {
			return invitation.used;
		},
		get incomingToken() {
			return invitation.token;
		},
		get shareLink() {
			return invitation.link;
		},
		get linkExpiresAt() {
			return invitation.expiresAt;
		},
		get creatingLink() {
			return creatingLink;
		},
		get photosExpireAt() {
			return photos.expiresAt;
		},
		mount,
		createLink,
		joinLink,
		revokeLink,
		shareInvitation: () => invitation.share(),
		copyInvitation: () => invitation.copy(),
		select,
		addPhotos,
		restartSharing,
		action,
		save: () => photos.save(),
		discard: () => photos.discard(),
		convertPhoto: (index: number, mode: ConversionMode) => photos.convert(index, mode),
		shareJpeg: (index: number) => photos.shareJpeg(index),
		checkPhotoExpiry,
		removePhoto,
		previewFailed: (index: number) => photos.previewFailed(index)
	};
}
