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
	let phase = $state<'waiting' | 'confirm' | 'connecting' | 'transferring'>(
		'waiting'
	);
	let confirmed = $state(false);
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

	function discard() {
		for (const item of received) URL.revokeObjectURL(item.url);
		received = [];
		completed = false;
	}
	function cleanupTransfer() {
		abort.abort();
		peer?.close();
		peer = undefined;
		receiver?.dispose();
		receiver = undefined;
		clearTimeout(watchdog);
		clearTimeout(requestTimer);
		request = undefined;
		requesting = false;
		confirmed = false;
	}
	function disconnect(state: 'idle' | 'offline' = 'idle') {
		generation++;
		discoveryGeneration++;
		sessionAbort?.abort();
		sessionAbort = undefined;
		signaling?.close();
		signaling = undefined;
		cleanupTransfer();
		clearInterval(discoverTimer);
		discoverTimer = undefined;
		searching = false;
		discovering = false;
		devices = [];
		recipient = undefined;
		session = undefined;
		connection = state;
	}

	function send(message: Parameters<Signaling['send']>[0]) {
		if (!signaling) throw new Error('再接続してください。');
		signaling.send(message);
	}
	function fail(cause: unknown) {
		error =
			cause instanceof Error
				? cause.message
				: '処理に失敗しました。再試行してください。';
		if (request) {
			try {
				send({ type: 'cancel', id: request.id });
			} catch {
				/* Already disconnected. */
			}
		}
		disconnect('offline');
		if (!completed) discard();
	}
	function touch() {
		clearTimeout(watchdog);
		watchdog = setTimeout(
			() =>
				fail(
					new Error('転送が止まりました。画面を開いたまま再試行してください。')
				),
			60_000
		);
	}
	async function connect() {
		if (disposed || connection === 'connecting') return;
		disconnect();
		const current = generation;
		error = '';
		notice = '';
		connection = 'connecting';
		searching = true;
		sessionAbort = new AbortController();
		try {
			if (!window.isSecureContext || !window.RTCPeerConnection)
				throw new Error('HTTPSとWebRTCに対応したブラウザで開いてください。');
			const next = await createSession(sessionAbort.signal);
			if (disposed || current !== generation) return;
			session = next;
			signaling = new Signaling(
				next,
				(message) => {
					signalQueue = signalQueue
						.then(async () => {
							if (!disposed && current === generation) await handle(message);
						})
						.catch((e) => {
							if (
								current === generation &&
								!disposed &&
								!(e instanceof Error && e.name === 'AbortError')
							)
								fail(e);
						});
				},
				() => {
					if (current !== generation || disposed) return;
					fail(new Error('接続が切れました。再接続して相手を探してください。'));
				}
			);
		} catch (e) {
			if (current === generation) {
				fail(e);
			}
		}
	}
	async function startDiscovery() {
		if (disposed || connection === 'connecting') return;
		flowStarted = true;
		if (connection !== 'online') {
			await connect();
			return;
		}
		const pending = search();
		const current = discoveryGeneration;
		const centerCard = async () => {
			await tick();
			if (current !== discoveryGeneration || (!searching && !discovering))
				return;
			discoverySection?.scrollIntoView({
				block: 'center',
				behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
					? 'instant'
					: 'smooth'
			});
		};
		await centerCard();
		await pending;
		await centerCard();
	}

	async function search() {
		if (searching || request || requesting || connection !== 'online') return;
		searching = true;
		const current = generation;
		const discovery = ++discoveryGeneration;
		try {
			const location = await locate();
			if (
				disposed ||
				current !== generation ||
				discovery !== discoveryGeneration ||
				connection !== 'online'
			)
				return;
			send({ type: 'presence', location });
			discovering = true;
			locationMessage =
				location.accuracy > 500
					? '位置情報の誤差が大きいため、広めの範囲から候補を表示しています。'
					: '近くの端末を探しています。相手も「近くの人を探す」を押してください。';
			if (!discoverTimer)
				discoverTimer = setInterval(() => {
					void search();
				}, 30_000);
		} catch (e) {
			if (current !== generation || discovery !== discoveryGeneration) return;
			locationMessage =
				e instanceof Error ? e.message : '位置情報を取得できません。';
			if (request) fail(e);
			else disconnect();
		} finally {
			if (current === generation && discovery === discoveryGeneration)
				searching = false;
		}
	}
	function stopDiscovery() {
		disconnect();
		locationMessage =
			'探索を停止しました。再開すると、近くの端末に表示されます。';
	}
	async function select(event: Event) {
		const files = Array.from((event.target as HTMLInputElement).files ?? []);
		selecting = true;
		error = '';
		try {
			const result = await describePhotos(files);
			selected = files;
			metadata = result;
		} catch (e) {
			selected = [];
			metadata = [];
			error = e instanceof Error ? e.message : '写真を選び直してください。';
		} finally {
			selecting = false;
		}
	}
	function invite(device: Device) {
		if (
			!metadata.length ||
			selecting ||
			request ||
			requesting ||
			received.length ||
			connection !== 'online' ||
			!devices.some((nearby) => nearby.id === device.id)
		)
			return;
		error = '';
		notice = '';
		requesting = true;
		discard();
		try {
			send({ type: 'request', to: device.id, files: metadata });
			requestTimer = setTimeout(() => {
				requesting = false;
				error = '応答がありません。再接続してください。';
			}, 10_000);
		} catch (e) {
			fail(e);
		}
	}
	function action(
		type: 'accept' | 'reject' | 'confirm' | 'cancel',
		word?: string
	) {
		if (!request) return;
		try {
			if (type === 'confirm') {
				if (!word || confirmed) return;
				send({ type, id: request.id, word });
			} else send({ type, id: request.id });
			if (type === 'accept') phase = 'confirm';
			if (type === 'confirm') confirmed = true;
			if (type === 'cancel' || type === 'reject') {
				disconnect();
				discard();
				notice =
					type === 'reject' ? '受信を辞退しました。' : '転送を中止しました。';
			}
		} catch (e) {
			fail(e);
		}
	}
	async function handle(message: ServerMessage) {
		if (message.type === 'ready') {
			connection = 'online';
			searching = false;
			void startDiscovery();
			return;
		}
		if (message.type === 'nearby') {
			devices = message.devices;
			return;
		}
		if (message.type === 'error') {
			requesting = false;
			clearTimeout(requestTimer);
			if (request) fail(new Error(message.message));
			else error = message.message;
			return;
		}
		if (message.type === 'requested') {
			if (completed && received.length && message.to.id === session?.id) {
				send({ type: 'reject', id: message.id });
				notice =
					'前の写真が残っているため、新しい受信を辞退しました。保存後に写真を破棄すると、次の転送ができます。';
				return;
			}
			clearTimeout(requestTimer);
			requesting = false;
			discard();
			request = message;
			bytes = 0;
			phase = 'waiting';
			confirmed = false;
			error = '';
			notice = '';
			relay = undefined;
			watchdog = setTimeout(
				() =>
					fail(
						new Error('確認の有効期限が切れました。もう一度送信してください。')
					),
				LIMITS.requestMs + 1000
			);
			await tick();
			transferSection?.scrollIntoView({ block: 'center' });
			return;
		}
		if (!request || message.id !== request.id) return;
		if (message.type === 'accepted') {
			phase = 'confirm';
			return;
		}
		if (message.type === 'start') {
			phase = 'connecting';
			touch();
			await start();
			return;
		}
		if (message.type === 'signal') {
			await peer?.receive(message.signal);
			return;
		}
		if (message.type === 'ended') {
			if (message.reason === 'complete') {
				completed = true;
				notice = sending
					? '相手の端末で、すべての写真の受信とデータ一致を確認しました。'
					: '写真を受け取りました。保存するには、下のボタンを押してください。';
			} else {
				const messages = {
					rejected: '相手が受信を辞退しました。',
					mismatch:
						'あいことばが違うため転送を中止しました。相手を確認して、もう一度送信してください。',
					cancelled: '転送を中止しました。',
					disconnected: '相手との接続が切れました。再試行してください。',
					timeout: '有効期限が切れました。もう一度送信してください。'
				};
				error = messages[message.reason];
				discard();
			}
			disconnect();
			if (completed && received.length) {
				await tick();
				receivedSection?.scrollIntoView({ block: 'start' });
			}
		}
	}
	async function start() {
		const transfer = request;
		if (!transfer || !session) return;
		abort = new AbortController();
		const signal = abort.signal;
		const response = await fetch('/api/ice', {
			method: 'POST',
			headers: { Authorization: `Bearer ${session.token}` },
			signal
		});
		const config = (await response.json()) as {
			iceServers: RTCIceServer[];
			relay: boolean;
			error?: string;
		};
		if (signal.aborted || request?.id !== transfer.id) return;
		if (!response.ok)
			throw new Error(config.error ?? '接続の準備に失敗しました。');
		relay = config.relay;
		const isSender = transfer.from.id === session.id;
		let attached = false;
		const attach = (channel: RTCDataChannel) => {
			if (attached || signal.aborted) {
				channel.close();
				return;
			}
			attached = true;
			channel.binaryType = 'arraybuffer';
			const open = () => {
				if (signal.aborted) return;
				phase = 'transferring';
				touch();
				if (isSender)
					void sendPhotos(channel, selected, transfer.files, signal, (n) => {
						bytes = n;
						touch();
					}).catch((e) => {
						if (!signal.aborted) fail(e);
					});
			};
			channel.onopen = open;
			if (channel.readyState === 'open') open();
			channel.onerror = () => {
				if (!signal.aborted) fail(new Error('写真の転送に失敗しました。'));
			};
			channel.onclose = () => {
				if (!signal.aborted && !completed)
					fail(new Error('写真の転送が中断されました。'));
			};
			if (isSender) {
				channel.onmessage = (event) => {
					if (signal.aborted) return;
					if (event.data !== '{"type":"verified"}' || bytes !== total) {
						fail(new Error('不正な受信確認です。'));
						return;
					}
					completed = true;
					channel.send('{"type":"verified-ack"}');
					touch();
				};
			} else {
				let verified = false;
				receiver = new PhotoReceiver(
					transfer.files,
					(n) => {
						bytes = n;
						touch();
					},
					(file) => {
						received = [
							...received,
							{
								file,
								url: URL.createObjectURL(file),
								preview: !['image/heic', 'image/heif'].includes(file.type)
							}
						];
					},
					() => {
						verified = true;
						channel.send('{"type":"verified"}');
						touch();
					}
				);
				const current = receiver;
				let queue = Promise.resolve();
				let queuedBytes = 0;
				channel.onmessage = (event) => {
					const size =
						event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
					queuedBytes += size;
					if (
						size > LIMITS.chunk ||
						queuedBytes > LIMITS.bytes ||
						(typeof event.data === 'string' && event.data.length > 1024)
					) {
						fail(new Error('受信サイズの上限を超えました。'));
						return;
					}
					queue = queue
						.then(async () => {
							try {
								if (signal.aborted) return;
								if (verified && event.data === '{"type":"verified-ack"}') {
									completed = true;
									send({ type: 'complete', id: transfer.id });
									return;
								}
								await current.consume(event.data);
							} finally {
								queuedBytes -= size;
							}
						})
						.catch((e) => {
							if (!signal.aborted) fail(e);
						});
				};
			}
		};
		peer = new PhotoPeer(
			config.iceServers,
			(s) => {
				if (!signal.aborted)
					send({ type: 'signal', id: transfer.id, signal: s });
			},
			attach,
			(e) => {
				if (!signal.aborted) fail(e);
			}
		);
		if (isSender) await peer.offer(attach);
	}
	async function save() {
		sharing = true;
		error = '';
		try {
			const result = await sharePhotos(received.map((item) => item.file));
			notice =
				result === 'shared'
					? '共有シートの操作を終了しました。写真アプリに保存されたか確認してください。'
					: result === 'cancelled'
						? '共有をキャンセルしました。写真はこの画面に残っています。'
						: 'このブラウザは写真の共有に対応していません。各写真の「ダウンロード」を使ってください。';
		} catch {
			error = '共有できませんでした。各写真のダウンロードをお試しください。';
		} finally {
			sharing = false;
		}
	}
	onMount(() => {
		const leave = () => {
			disposed = true;
			disconnect();
			discard();
		};
		const resume = (e: PageTransitionEvent) => {
			if (e.persisted) {
				disposed = false;
			}
		};
		window.addEventListener('pagehide', leave);
		window.addEventListener('pageshow', resume);
		return () => {
			leave();
			window.removeEventListener('pagehide', leave);
			window.removeEventListener('pageshow', resume);
		};
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
	bind:confirmed
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
