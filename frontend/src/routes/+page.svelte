<script lang="ts">
	import { onMount, tick } from 'svelte';
	import DropView from '$lib/components/DropView.svelte';
	import {
		LIMITS,
		type Device,
		type PhotoMeta,
		type ServerMessage,
		type Session
	} from '../../../shared/protocol.ts';
	import { locate } from '$lib/discovery';
	import { describePhotos, sharePhotos } from '$lib/photos';
	import { createSession, Signaling } from '$lib/webrtc/signaling';
	import { PhotoPeer } from '$lib/webrtc/peer';
	import { PhotoReceiver, sendPhotos } from '$lib/webrtc/transfer';

	type RequestInfo = Extract<ServerMessage, { type: 'requested' }>;
	let flowStarted = $state(false);
	let session = $state<Session>();
	let connection = $state<'idle' | 'connecting' | 'online' | 'offline'>('idle');
	let devices = $state<Device[]>([]);
	let recipient = $state<Device>();
	let photosHeading = $state<HTMLHeadingElement>();
	let discoverySection = $state<HTMLElement>();
	async function chooseRecipient(device: Device) {
		recipient = device;
		await tick();
		photosHeading?.focus();
	}
	let discovering = $state(false);
	let searching = $state(false);
	let locationMessage = $state(
		'位置情報を使って、近くでこのページを開いている人を探します。'
	);
	let selected = $state<File[]>([]);
	let metadata = $state<PhotoMeta[]>([]);
	let selecting = $state(false);
	let requesting = $state(false);
	let request = $state<RequestInfo>();
	let phase = $state<'waiting' | 'connecting' | 'transferring'>('waiting');
	let bytes = $state(0);
	let received = $state<{ file: File; url: string; preview: boolean }[]>([]);
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
	let discoverTimer: ReturnType<typeof setInterval> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let requestTimer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let discoveryGeneration = 0;
	let signalQueue = Promise.resolve();
	let disposed = false;
	const sending = $derived(!!request && request.from.id === session?.id);
	const total = $derived(
		request?.files.reduce((sum, f) => sum + f.size, 0) ?? 0
	);

	const TRANSFER_STOPPED =
		'転送が止まりました。画面を開いたまま再試行してください。';
	const CONFIRM_EXPIRED =
		'確認の有効期限が切れました。もう一度送信してください。';
	const RECEIVED_NOTICE =
		'写真を受け取りました。保存するには、下のボタンを押してください。';
	const SENT_NOTICE =
		'相手の端末で、すべての写真の受信とデータ一致を確認しました。';
	const PREVIOUS_PHOTOS =
		'前の写真が残っているため、新しい受信を辞退しました。保存後に写真を破棄すると、次の転送ができます。';
	const endMessages = {
		rejected: '相手が受信を辞退しました。',
		cancelled: '転送を中止しました。',
		disconnected: '相手との接続が切れました。再試行してください。',
		timeout: '有効期限が切れました。もう一度送信してください。'
	};
	const shareMessages = {
		shared:
			'共有シートの操作を終了しました。写真アプリに保存されたか確認してください。',
		cancelled: '共有をキャンセルしました。写真はこの画面に残っています。',
		unsupported:
			'このブラウザは写真の共有に対応していません。各写真の「ダウンロード」を使ってください。'
	};
	function discard() {
		for (const item of received) {
			URL.revokeObjectURL(item.url);
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
		clearTimeout(requestTimer);
		request = undefined;
		requesting = false;
	}
	function closeSignaling() {
		generation++;
		discoveryGeneration++;
		sessionAbort?.abort();
		sessionAbort = undefined;
		signaling?.close();
		signaling = undefined;
	}
	function resetDiscovery() {
		clearInterval(discoverTimer);
		discoverTimer = undefined;
		searching = false;
		discovering = false;
		devices = [];
		recipient = undefined;
	}
	function disconnect(state: 'idle' | 'offline' = 'idle') {
		closeSignaling();
		cleanupTransfer();
		resetDiscovery();
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
		if (!completed) {
			discard();
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
		searching = true;
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
			fail(new Error('接続が切れました。再接続して相手を探してください。'));
		}
	}
	function checkBrowser() {
		if (!window.isSecureContext || !window.RTCPeerConnection) {
			throw new Error('HTTPSとWebRTCに対応したブラウザで開いてください。');
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

	function scrollDiscovery() {
		const reduced = window.matchMedia(
			'(prefers-reduced-motion: reduce)'
		).matches;
		discoverySection?.scrollIntoView({
			block: 'center',
			behavior: reduced ? 'instant' : 'smooth'
		});
	}
	async function centerDiscovery(current: number) {
		await tick();
		if (current === discoveryGeneration && (searching || discovering)) {
			scrollDiscovery();
		}
	}

	async function searchAndCenter() {
		const pending = search();
		const current = discoveryGeneration;
		await centerDiscovery(current);
		await pending;
		await centerDiscovery(current);
	}
	async function startDiscovery() {
		if (disposed || connection === 'connecting') {
			return;
		}
		flowStarted = true;
		await (connection !== 'online' ? connect() : searchAndCenter());
	}

	type SearchVersion = { current: number; discovery: number };
	function currentSearch(version: SearchVersion) {
		return (
			version.current === generation &&
			version.discovery === discoveryGeneration
		);
	}
	function locationNotice(accuracy: number) {
		return accuracy > 500
			? '位置情報の誤差が大きいため、広めの範囲から候補を表示しています。'
			: '近くの端末を探しています。相手も「近くの人を探す」を押してください。';
	}
	function refreshDiscovery() {
		void search();
	}
	function publishLocation(location: Awaited<ReturnType<typeof locate>>) {
		send({ type: 'presence', location });
		discovering = true;
		locationMessage = locationNotice(location.accuracy);
		if (!discoverTimer) {
			discoverTimer = setInterval(refreshDiscovery, 30_000);
		}
	}

	async function findLocation(version: SearchVersion) {
		const location = await locate();
		if (disposed || !currentSearch(version) || connection !== 'online') {
			return;
		}
		publishLocation(location);
	}
	function endFailedSearch(e: unknown) {
		if (request) {
			fail(e);
		} else {
			disconnect();
		}
	}
	function searchFailed(e: unknown, version: SearchVersion) {
		if (!currentSearch(version)) {
			return;
		}
		locationMessage =
			e instanceof Error ? e.message : '位置情報を取得できません。';
		endFailedSearch(e);
	}

	function finishSearch(version: SearchVersion) {
		if (currentSearch(version)) {
			searching = false;
		}
	}
	async function runSearch(version: SearchVersion) {
		try {
			await findLocation(version);
		} catch (e) {
			searchFailed(e, version);
		} finally {
			finishSearch(version);
		}
	}

	async function search() {
		if (searching || request || requesting || connection !== 'online') {
			return;
		}
		searching = true;
		await runSearch({ current: generation, discovery: ++discoveryGeneration });
	}
	function stopDiscovery() {
		disconnect();
		locationMessage =
			'探索を停止しました。再開すると、近くの端末に表示されます。';
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
		const files = Array.from((event.target as HTMLInputElement).files ?? []);
		selecting = true;
		error = '';
		await selectFiles(files);
	}

	function canInvite(device: Device) {
		const busy = selecting || request || requesting || received.length;
		return (
			metadata.length &&
			!busy &&
			connection === 'online' &&
			devices.some((nearby) => nearby.id === device.id)
		);
	}
	function requestTimedOut() {
		requesting = false;
		error = '応答がありません。再接続してください。';
	}
	function sendInvitation(device: Device) {
		try {
			send({ type: 'request', to: device.id, files: metadata });
			requestTimer = setTimeout(requestTimedOut, 10_000);
		} catch (e) {
			fail(e);
		}
	}
	function invite(device: Device) {
		if (!canInvite(device)) {
			return;
		}
		error = '';
		notice = '';
		requesting = true;
		discard();
		sendInvitation(device);
	}
	function finishAction(type: 'accept' | 'reject' | 'cancel') {
		if (type === 'accept') {
			phase = 'connecting';
			return;
		}
		disconnect();
		discard();
		notice =
			type === 'reject' ? '受信を辞退しました。' : '転送を中止しました。';
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
		searching = false;
		void startDiscovery();
	}
	function serverError(message: string) {
		requesting = false;
		clearTimeout(requestTimer);
		if (request) {
			fail(new Error(message));
		} else {
			error = message;
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
		clearTimeout(requestTimer);
		requesting = false;
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

	async function ended(
		reason: Extract<ServerMessage, { type: 'ended' }>['reason']
	) {
		transferOutcome(reason);
		disconnect();
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
			return ended(message.reason);
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
		if (message.type === 'nearby') {
			devices = message.devices;
			return;
		}
		return handleRequestMessage(message);
	}
	type RequestMessage = Exclude<ServerMessage, { type: 'ready' | 'nearby' }>;
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
		received = [...received, { file, url: URL.createObjectURL(file), preview }];
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
		sharing = true;
		error = '';
		await tryShare();
	}

	function leave() {
		disposed = true;
		disconnect();
		discard();
	}
	function resume(e: PageTransitionEvent) {
		if (e.persisted) {
			disposed = false;
		}
	}
	function unmount() {
		leave();
		window.removeEventListener('pagehide', leave);
		window.removeEventListener('pageshow', resume);
	}
	onMount(() => {
		window.addEventListener('pagehide', leave);
		window.addEventListener('pageshow', resume);
		return unmount;
	});
</script>

<DropView
	bind:flowStarted
	bind:session
	bind:connection
	bind:devices
	bind:recipient
	bind:photosHeading
	bind:discoverySection
	bind:discovering
	bind:searching
	bind:locationMessage
	bind:selected
	bind:metadata
	bind:selecting
	bind:requesting
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
	connect={startDiscovery}
	{startDiscovery}
	{stopDiscovery}
	{chooseRecipient}
	{select}
	{invite}
	{action}
	{save}
	{discard}
/>
