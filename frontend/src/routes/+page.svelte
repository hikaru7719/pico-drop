<script lang="ts">
	import {
		ReceivedPhotos,
		releasePhoto,
		type ReceivedPhoto
	} from '$lib/photos/received';
	import type { PhotoAccess, ConversionMode } from '../../../shared/photos.ts';
	import { onMount, tick } from 'svelte';
	import DropView from '$lib/components/DropView.svelte';
	import {
		LIMITS,
		type PhotoMeta,
		type ServerMessage,
		type Session
	} from '../../../shared/protocol.ts';
	import { describePhotos, sharePhotos } from '$lib/photos';
	import { createSession, Signaling } from '$lib/webrtc/signaling';
	import { PhotoPeer } from '$lib/webrtc/peer';
	import { PhotoReceiver, sendPhotos } from '$lib/webrtc/transfer';

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
	let input = $state<HTMLInputElement>();
	let transferSection = $state<HTMLElement>();
	let receivedSection = $state<HTMLElement>();
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
		const next = await createSession(sessionAbort!.signal);
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

	async function joinLink() {
		if (connection === 'connecting' || request || !incomingToken) {
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
	async function select(event: Event) {
		if (shareLink || creatingLink || request) {
			return;
		}
		const files = Array.from((event.target as HTMLInputElement).files ?? []);
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
		transferSection?.scrollIntoView({ block: 'center' });
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
			receivedSection?.scrollIntoView({ block: 'start' });
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

	type IceConfig = {
		iceServers: RTCIceServer[];
		relay: boolean;
		error?: string;
	};
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
	class TransferConnection {
		private attached = false;
		readonly transfer: RequestInfo;
		readonly signal: AbortSignal;
		readonly isSender: boolean;
		constructor(transfer: RequestInfo, signal: AbortSignal, isSender: boolean) {
			this.transfer = transfer;
			this.signal = signal;
			this.isSender = isSender;
		}

		failIfActive(e: unknown) {
			if (!this.signal.aborted) {
				fail(e);
			}
		}
		attach = (channel: RTCDataChannel) => {
			if (this.attached || this.signal.aborted) {
				channel.close();
			} else {
				this.attachChannel(channel);
			}
		};
		attachChannel(channel: RTCDataChannel) {
			this.attached = true;
			channel.binaryType = 'arraybuffer';
			this.listen(channel);
			if (this.isSender) {
				channel.onmessage = (event) => this.confirm(channel, event.data);
			} else {
				new IncomingChannel(this, channel);
			}
		}

		listen(channel: RTCDataChannel) {
			channel.onopen = () => this.open(channel);
			if (channel.readyState === 'open') {
				this.open(channel);
			}
			channel.onerror = () =>
				this.failIfActive(new Error('写真の転送に失敗しました。'));
			channel.onclose = () => this.closed();
		}
		closed() {
			if (!completed) {
				this.failIfActive(new Error('写真の転送が中断されました。'));
			}
		}

		open(channel: RTCDataChannel) {
			if (this.signal.aborted) {
				return;
			}
			phase = 'transferring';
			touch();
			if (this.isSender) {
				void this.sendFiles(channel).catch((e) => this.failIfActive(e));
			}
		}
		async sendFiles(channel: RTCDataChannel) {
			await sendPhotos({
				channel,
				files: selected,
				metadata: this.transfer.files,
				signal: this.signal,
				progress: updateProgress
			});
		}
		confirm(channel: RTCDataChannel, data: unknown) {
			if (this.signal.aborted) {
				return;
			}
			if (data !== '{"type":"verified"}' || bytes !== total) {
				fail(new Error('不正な受信確認です。'));
			} else {
				this.acknowledge(channel);
			}
		}
		acknowledge(channel: RTCDataChannel) {
			completed = true;
			channel.send('{"type":"verified-ack"}');
			touch();
		}

		sendSignal(s: Parameters<PhotoPeer['receive']>[0]) {
			if (!this.signal.aborted) {
				send({ type: 'signal', id: this.transfer.id, signal: s });
			}
		}
		createPeer(config: IceConfig) {
			return new PhotoPeer(
				config.iceServers,
				(s) => this.sendSignal(s),
				this.attach,
				(e) => this.failIfActive(e)
			);
		}
		async connect(config: IceConfig) {
			peer = this.createPeer(config);
			if (this.isSender) {
				await peer.offer(this.attach);
			}
		}
	}
	class IncomingChannel {
		private verified = false;
		private queue = Promise.resolve();
		private queuedBytes = 0;
		private current: PhotoReceiver;
		private transfer: TransferConnection;
		private channel: RTCDataChannel;
		constructor(transfer: TransferConnection, channel: RTCDataChannel) {
			this.transfer = transfer;
			this.channel = channel;
			this.current = this.createReceiver();
			receiver = this.current;
			channel.onmessage = (event) => this.enqueue(event.data);
		}

		createReceiver() {
			return new PhotoReceiver(
				this.transfer.transfer.files,
				updateProgress,
				receivedPhoto,
				() => this.verify()
			);
		}

		verify() {
			this.verified = true;
			this.channel.send('{"type":"verified"}');
			touch();
		}
		validSize(data: unknown, size: number) {
			return (
				size <= LIMITS.chunk &&
				this.queuedBytes <= LIMITS.bytes &&
				!(typeof data === 'string' && data.length > 1024)
			);
		}
		enqueue(data: unknown) {
			const size = data instanceof ArrayBuffer ? data.byteLength : 0;
			this.queuedBytes += size;
			if (!this.validSize(data, size)) {
				fail(new Error('受信サイズの上限を超えました。'));
			} else {
				this.queueMessage(data, size);
			}
		}
		queueMessage(data: unknown, size: number) {
			this.queue = this.queue
				.then(() => this.consume(data, size))
				.catch((e) => this.transfer.failIfActive(e));
		}

		async consume(data: unknown, size: number) {
			try {
				await this.receive(data);
			} finally {
				this.queuedBytes -= size;
			}
		}
		async receive(data: unknown) {
			if (this.transfer.signal.aborted) {
				return;
			}
			if (this.verified && data === '{"type":"verified-ack"}') {
				this.complete();
			} else {
				await this.current.consume(data);
			}
		}
		complete() {
			completed = true;
			send({ type: 'complete', id: this.transfer.transfer.id });
		}
	}
	function checkIce(response: Response, config: IceConfig) {
		if (!response.ok) {
			throw new Error(config.error ?? '接続の準備に失敗しました。');
		}
		relay = config.relay;
	}
	async function connectTransfer(
		transfer: RequestInfo,
		signal: AbortSignal,
		config: IceConfig
	) {
		const isSender = transfer.from.id === session!.id;
		await new TransferConnection(transfer, signal, isSender).connect(config);
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
		if (input) {
			input.value = '';
		}
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
		} else {
			error =
				'共有リンクが正しくありません。送信者に作り直してもらってください。';
		}
	}

	onMount(() => {
		readInvitation();
		window.addEventListener('hashchange', readInvitation);
		window.addEventListener('pagehide', leave);
		window.addEventListener('pageshow', resume);
		window.addEventListener('focus', checkPhotoExpiry);
		window.addEventListener('visibilitychange', checkPhotoExpiry);
		return unmount;
	});
</script>

<DropView
	bind:flowStarted
	bind:session
	bind:connection
	bind:selected
	bind:metadata
	bind:selecting
	bind:request
	bind:phase
	bind:bytes
	bind:received
	bind:completed
	bind:notice
	bind:error
	bind:relay
	bind:sharing
	bind:input
	bind:transferSection
	bind:receivedSection
	connect={incomingToken ? joinLink : createLink}
	{incomingToken}
	{shareLink}
	{linkExpiresAt}
	{creatingLink}
	{createLink}
	{joinLink}
	{revokeLink}
	{shareInvitation}
	{copyInvitation}
	{select}
	{action}
	{save}
	{discard}
	{photosExpireAt}
	{convertPhoto}
	{shareJpeg}
	{checkPhotoExpiry}
/>
