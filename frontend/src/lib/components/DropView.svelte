<script lang="ts">
	import { isHeic, type ConversionMode } from '../../../../shared/photos.ts';
	import type { ReceivedPhoto } from '$lib/photos/received';
	import DiscoveryPulse from './DiscoveryPulse.svelte';
	import TransferProgress from './TransferProgress.svelte';
	import { formatBytes } from '$lib/photos';
	import type {
		Device,
		PhotoMeta,
		ServerMessage,
		Session
	} from '../../../../shared/protocol';
	type Props = {
		flowStarted?: boolean;
		session?: Session | undefined;
		connection?: 'idle' | 'connecting' | 'online' | 'offline';
		devices?: Device[];
		recipient?: Device | undefined;
		photosHeading?: HTMLHeadingElement | undefined;
		discoverySection?: HTMLElement | undefined;
		discovering?: boolean;
		searching?: boolean;
		locationMessage?: string;
		selected?: File[];
		metadata?: PhotoMeta[];
		selecting?: boolean;
		requesting?: boolean;
		request?: Extract<ServerMessage, { type: 'requested' }> | undefined;
		phase?: 'waiting' | 'connecting' | 'transferring';
		bytes?: number;
		received?: ReceivedPhoto[];
		photosExpireAt?: number;
		convertPhoto?: (index: number, mode: ConversionMode) => void;
		shareJpeg?: (index: number) => void;
		checkPhotoExpiry?: () => boolean;
		completed?: boolean;
		notice?: string;
		error?: string;
		relay?: boolean | undefined;
		sharing?: boolean;
		input?: HTMLInputElement | undefined;
		transferSection?: HTMLElement | undefined;
		receivedSection?: HTMLElement | undefined;
		connect?: () => void;
		startDiscovery?: () => void;
		stopDiscovery?: () => void;
		chooseRecipient?: (device: Device) => void;
		select?: (event: Event) => void;
		invite?: (device: Device) => void;
		action?: (type: 'accept' | 'reject' | 'cancel') => void;
		save?: () => void;
		discard?: () => void;
	};
	let {
		flowStarted = $bindable(false),
		session = $bindable(undefined),
		connection = $bindable('idle'),
		devices = $bindable([]),
		recipient = $bindable(undefined),
		photosHeading = $bindable(undefined),
		discoverySection = $bindable(undefined),
		discovering = $bindable(false),
		searching = $bindable(false),
		locationMessage = $bindable(
			'位置情報を使って、近くでこのページを開いている人を探します。'
		),
		selected = $bindable([]),
		metadata = $bindable([]),
		selecting = $bindable(false),
		requesting = $bindable(false),
		request = $bindable(undefined),
		phase = $bindable('waiting'),
		bytes = $bindable(0),
		received = $bindable([]),
		completed = $bindable(false),
		notice = $bindable(''),
		error = $bindable(''),
		relay = $bindable(undefined),
		sharing = $bindable(false),
		input = $bindable(undefined),
		transferSection = $bindable(undefined),
		receivedSection = $bindable(undefined),
		connect = () => {},
		startDiscovery = () => {},
		stopDiscovery = () => {},
		chooseRecipient = () => {},
		select = () => {},
		invite = () => {},
		action = () => {},
		save = () => {},
		photosExpireAt,
		convertPhoto = () => {},
		shareJpeg = () => {},
		checkPhotoExpiry = () => true,
		discard = () => {}
	}: Props = $props();
	const inFlow = $derived(
		flowStarted ||
			searching ||
			discovering ||
			!!recipient ||
			!!request ||
			completed ||
			received.length > 0
	);
	$effect(() => {
		if (inFlow) {
			flowStarted = true;
		}
	});
	function centerDiscovery(event: TransitionEvent) {
		if (
			event.target !== event.currentTarget ||
			event.propertyName !== 'grid-template-rows'
		) {
			return;
		}
		centerActiveDiscovery();
	}

	const headline = 'Photos, Right Nearby.';
	const typingInterval = 180;
	const headlineCycle = 250 + (headline.length - 1) * typingInterval + 3000;
	let headlineReplay = $state(0);
	function centerActiveDiscovery() {
		if (searching || discovering) {
			discoverySection?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
	}
	function replayHeadline(replay: number) {
		return setTimeout(() => {
			headlineReplay = replay;
		}, headlineCycle * replay);
	}
	function watchMotion(motion: MediaQueryList) {
		const timers = [1, 2].map(replayHeadline);
		const stop = () => timers.forEach(clearTimeout);
		motion.addEventListener('change', stop);
		return () => {
			stop();
			motion.removeEventListener('change', stop);
		};
	}
	$effect(() => {
		if (inFlow) {
			return;
		}
		const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
		if (!motion.matches) {
			return watchMotion(motion);
		}
	});

	const headlineWords = headline.split(' ').map((word, index, words) => ({
		word,
		offset: words.slice(0, index).join(' ').length + (index ? 1 : 0)
	}));

	const recipientAvailable = $derived(
		!!recipient && devices.some((device) => device.id === recipient?.id)
	);
	const sending = $derived(!!request && request.from.id === session?.id);
	const total = $derived(
		request?.files.reduce((sum, f) => sum + f.size, 0) ?? 0
	);
	const selectedBytes = $derived(selected.reduce((sum, f) => sum + f.size, 0));
</script>

<svelte:head>
	<title>Pico Drop — Share photos nearby.</title>
	<meta
		name="description"
		content="近くの人へ、写真をさっと。アプリもログインも不要で写真を共有。"
	/>
</svelte:head>

<main class:in-flow={inFlow}>
	<header>
		<a
			class="brand"
			href="/"
			aria-label="Pico Drop ホーム"
			><span
				class="wordmark"
				aria-hidden="true">Pico Drop</span
			></a
		>
		<div
			class="identity"
			role="status"
		>
			<span class="identity-label">この端末の名前</span>
			<span class="badge"
				><span
					class:online={connection === 'online'}
					class="dot"
					aria-hidden="true"
				></span>{connection === 'online'
					? session?.name
					: connection === 'connecting'
						? '接続中…'
						: connection === 'idle'
							? '未接続'
							: 'オフライン'}</span
			>
		</div>
	</header>
	<div
		class="intro-shell"
		class:collapsed={inFlow}
		aria-hidden={inFlow}
		inert={inFlow}
	>
		<div class="intro-clip">
			<section class="intro">
				<h1 aria-label={headline}>
					{#key headlineReplay}
						{#each headlineWords as { word, offset }, wordIndex}<span
								class="headline-word"
								aria-hidden="true"
								>{#each [...word] as character, index}<span
										class="headline-character"
										class:last-character={offset + index ===
											headline.length - 1}
										style={`--type-delay: ${250 + (offset + index) * typingInterval}ms; --caret-duration: ${index === word.length - 1 && offset + index < headline.length - 1 ? typingInterval * 2 : typingInterval}ms`}
										>{character}</span
									>{/each}</span
							>{wordIndex < headlineWords.length - 1 ? ' ' : ''}{/each}
					{/key}
				</h1>
				<p>一緒に過ごした瞬間を、その場で。<br />ログインは不要です。</p>
			</section>
		</div>
	</div>
	{#if error}<div
			class="alert error"
			role="alert"
		>
			{error}
		</div>{/if}
	{#if notice}<div
			class="alert"
			role="status"
		>
			{notice}
		</div>{/if}
	{#if connection === 'offline'}<button
			class="primary reconnect"
			onclick={connect}>再接続する</button
		>{/if}
	{#if !request && !(completed && received.length)}
		<div class="workspace">
			{#if recipient}
				<section
					class="card photos"
					aria-labelledby="photos-heading"
				>
					<div class="section-heading">
						<h2
							id="photos-heading"
							bind:this={photosHeading}
							tabindex="-1"
						>
							写真を選んで送る
						</h2>
					</div>
					<div class="recipient-row">
						<p class="description">送信先：{recipient?.name}</p>
						<button
							class="text-button"
							disabled={requesting || selecting}
							onclick={() => {
								recipient = undefined;
							}}>相手を選び直す</button
						>
					</div>
					{#if !recipientAvailable}<p
							class="hint"
							role="status"
						>
							相手が見つかりません。相手の探索を確認するか、選び直してください。
						</p>{/if}
					<label
						class:disabled={!!request || requesting || selecting}
						class="picker"
						><span
							class="photo-icon"
							aria-hidden="true"
							><svg
								viewBox="0 0 48 48"
								fill="none"
								stroke="currentColor"
								stroke-width="1.8"
								><rect
									x="7"
									y="9"
									width="34"
									height="30"
									rx="5"
								/><circle
									cx="17"
									cy="19"
									r="3"
								/><path d="m8 33 10-9 8 7 6-6 9 9" /></svg
							></span
						><strong
							>{selecting
								? '写真を確認中…'
								: selected.length
									? `${selected.length}枚の写真を選択中`
									: '写真を選ぶ'}</strong
						><span
							>{selected.length
								? `${formatBytes(selectedBytes)} · タップして選び直す`
								: '10枚まで・合計50MBまで'}</span
						><input
							bind:this={input}
							type="file"
							accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
							multiple
							disabled={!!request || requesting || selecting}
							onchange={select}
						/></label
					>
					{#if selected.length}
						<div class="selection-heading">
							<span>選択した写真 · {selected.length}枚</span>
						</div>
						<ul class="file-list">
							{#each selected as file, index}<li>
									<span>{file.name}</span><small>{formatBytes(file.size)}</small
									>
									<button
										class="clear-selection"
										aria-label={`${file.name}を選択から外す`}
										title="この写真を選択から外す"
										disabled={!!request || requesting || selecting}
										onclick={() => {
											selected = selected.filter(
												(_, fileIndex) => fileIndex !== index
											);
											metadata = metadata.filter(
												(_, fileIndex) => fileIndex !== index
											);
											if (input) input.value = '';
										}}
										><svg
											viewBox="0 0 20 20"
											fill="none"
											stroke="currentColor"
											stroke-width="1.5"
											stroke-linecap="round"
											aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg
										></button
									>
								</li>{/each}
						</ul>
					{/if}
					<p class="hint">
						元の画質で送ります。写真に含まれる撮影場所などの情報も、そのまま相手に渡ります。
					</p>
					<button
						class="primary send-button"
						disabled={!metadata.length ||
							selecting ||
							requesting ||
							!recipientAvailable ||
							connection !== 'online'}
						onclick={() => {
							if (recipient) invite(recipient);
						}}>{requesting ? '送信を準備中…' : '送る'}</button
					>
				</section>
			{:else}
				<section
					class="card"
					bind:this={discoverySection}
					aria-labelledby="nearby-heading"
				>
					<div class="section-heading">
						<h2 id="nearby-heading">
							{devices.length ? '送る相手を選ぶ' : '近くの人を探す'}
						</h2>
					</div>
					<p class="description">
						{discovering
							? devices.length
								? '写真を送る相手を選んでください。受け取るだけなら、このまま待つだけです。'
								: '受け取るだけなら、このまま待つだけです。'
							: 'まずは、お互いに「近くの人を探す」を押してください。相手が見つかったら、写真を選んで送れます。'}
					</p>
					{#if !discovering && !searching}
						<button
							class="primary"
							disabled={connection === 'connecting'}
							onclick={() => {
								flowStarted = true;
								startDiscovery();
							}}>近くの人を探す</button
						>
					{/if}
					{#if !devices.length}
						<div
							class="discovery-reveal"
							class:expanded={searching || discovering}
							inert={!searching && !discovering}
							aria-hidden={!searching && !discovering}
							ontransitionend={centerDiscovery}
						>
							<div class="discovery-clip">
								<DiscoveryPulse locating={searching && !discovering} />
							</div>
						</div>
					{/if}
					{#if discovering && locationMessage.includes('誤差')}
						<p
							class="hint"
							role="status"
						>
							{locationMessage}
						</p>
					{:else if !discovering && !searching}
						<p
							class="hint"
							role="status"
						>
							{locationMessage}
						</p>
					{/if}

					{#if devices.length}<ul class="devices">
							{#each devices as device}<li>
									<span
										class="avatar"
										aria-hidden="true"
										><svg
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="1.5"
											><rect
												x="6"
												y="2"
												width="12"
												height="20"
												rx="3"
											/><path d="M10 18h4" /></svg
										></span
									>
									<div>
										<strong>{device.name}</strong><small>近くで待機中</small>
									</div>
									<button
										aria-label={`${device.name}を選ぶ`}
										disabled={requesting || !!received.length}
										onclick={() => chooseRecipient(device)}>選ぶ</button
									>
								</li>{/each}
						</ul>{/if}
					{#if discovering || searching}<button
							class="text-button"
							disabled={!!request}
							onclick={stopDiscovery}>探索を停止する</button
						>{/if}
					<p class="hint">
						位置情報は候補の発見だけに使います。送る前に相手の画面に表示された端末名を確認してください。
					</p>
				</section>
			{/if}
		</div>
	{/if}
	{#if request}
		<section
			class="card transfer"
			bind:this={transferSection}
			aria-labelledby="transfer-heading"
		>
			<h2 id="transfer-heading">
				{sending
					? `${request.to.name} へ送信`
					: `${request.from.name} から写真が届いています`}
			</h2>
			<p>{request.files.length}枚 · {formatBytes(total)}</p>
			{#if phase === 'waiting'}
				<p>
					{sending
						? '相手の承諾を待っています。写真はまだ送信していません。'
						: 'この相手から写真を受け取りますか？受け取ると転送が始まります。'}
				</p>
				{#if !sending}<div class="actions">
						<button
							class="primary"
							onclick={() => action('accept')}>受け取る</button
						><button onclick={() => action('reject')}>辞退する</button>
					</div>{/if}
			{:else}
				<TransferProgress
					{bytes}
					{total}
					{sending}
					connecting={phase === 'connecting'}
				/>
				<p class="hint">完了するまで画面を開いたままにしてください。</p>
				{#if relay === false}<p class="hint">
						中継サーバーは未設定です。直接接続できない回線では転送に失敗することがあります。
					</p>{/if}
			{/if}
			{#if sending || phase !== 'waiting'}
				<button
					class="text-button"
					onclick={() => action('cancel')}>中止する</button
				>
			{/if}
		</section>
	{/if}
	{#if completed && received.length}
		<section
			class="card received"
			bind:this={receivedSection}
			aria-labelledby="received-heading"
		>
			<h2 id="received-heading">{received.length}枚の写真を受け取りました</h2>
			<p class="description">
				iPhoneでは共有シートから「画像を保存」を選んでください。受信完了から10分、またはページを閉じると写真は破棄されます。保存済みの写真は端末に残ります。次の転送の前に、保存を確認して写真を破棄してください。
			</p>
			{#if photosExpireAt}<p class="hint">
					保存期限：{new Date(photosExpireAt).toLocaleTimeString('ja-JP')}
				</p>{/if}
			{#if received.some((photo) => isHeic(photo.file.type))}
				<p class="hint">
					HEICのプレビュー・JPEG変換を押すと、その写真をCloudflareへ送って処理します。サーバーへの写真保存は行いません。JPEGは画質が変わり、撮影情報は引き継がれない場合があります。原本はそのまま保存できます。
				</p>
			{/if}
			<div class="gallery">
				{#each received as item, index}<figure>
						{#if item.preview}<img
								src={item.previewUrl ?? item.url}
								alt={item.file.name}
								onerror={() => {
									item.preview = false;
								}}
							/>{:else}<div class="no-preview">
								プレビュー未表示<br /><small>原本は保存できます</small>
							</div>{/if}
						<figcaption>
							<a
								href={item.url}
								onclick={(event) => {
									if (!checkPhotoExpiry()) {
										event.preventDefault();
									}
								}}
								download={item.file.name}>{item.file.name}（原本）</a
							>
							{#if isHeic(item.file.type)}
								{#if !item.previewUrl}<button
										disabled={item.busy}
										onclick={() => convertPhoto(index, 'preview')}
										>プレビューを表示</button
									>{/if}
								{#if !item.jpegUrl}<button
										disabled={item.busy}
										onclick={() => convertPhoto(index, 'jpeg')}
										>JPEGに変換する</button
									>{/if}
								{#if item.busy}<p role="status">変換中…</p>{/if}
								{#if item.problem}<p role="status">{item.problem}</p>{/if}
								{#if item.jpegUrl && item.jpeg}
									<a
										href={item.jpegUrl}
										download={item.jpeg.name}
										onclick={(event) => {
											if (!checkPhotoExpiry()) {
												event.preventDefault();
											}
										}}>JPEGをダウンロード</a
									>
									<button onclick={() => shareJpeg(index)}
										>JPEGを保存・共有</button
									>
								{/if}
							{/if}
						</figcaption>
					</figure>{/each}
			</div>
			<div class="actions">
				<button
					class="primary"
					disabled={sharing}
					onclick={save}>写真に保存・共有</button
				><button onclick={discard}>写真を破棄する</button>
			</div>
		</section>
	{/if}
	<footer>
		<span>写真はサーバーに保存されません</span>
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f5f5f7;
		color: #1d1d1f;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
	}
	:global(*) {
		box-sizing: border-box;
	}
	:global(button),
	:global(input) {
		font: inherit;
	}
	:global(button) {
		cursor: pointer;
	}
	:global(button:disabled) {
		cursor: default;
		opacity: 0.45;
	}
	:global(button:focus-visible),
	:global(a:focus-visible),
	.picker:focus-within {
		outline: 3px solid #0071e3;
		outline-offset: 4px;
	}
	main {
		max-width: 1000px;
		margin: auto;
		padding: 32px clamp(20px, 5vw, 64px);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	header {
		max-width: 640px;
		margin-inline: auto;
		min-height: 40px;
	}
	.identity {
		min-width: 0;
		max-width: 55%;
		text-align: right;
	}
	.identity-label {
		display: block;
		color: #6e6e73;
		font-size: 10px;
		letter-spacing: 0.055em;
		line-height: 1.5;
		margin-bottom: 3px;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		color: #1d1d1f;
		text-decoration: none;
	}
	.wordmark {
		font-size: 20px;
		font-weight: 600;
		letter-spacing: normal;
		line-height: 1.4;
	}
	.badge {
		display: flex;
		justify-content: flex-end;
		color: #515156;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.015em;
	}
	.dot {
		width: 5px;
		height: 5px;
		flex-shrink: 0;
		border-radius: 50%;
		background: #86868b;
	}
	.dot.online {
		background: #248a3d;
	}
	.intro-shell,
	.discovery-reveal {
		display: grid;
		grid-template-rows: 1fr;
		opacity: 1;
		transition:
			grid-template-rows 800ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 400ms ease;
	}
	.intro-clip,
	.discovery-clip {
		min-height: 0;
		overflow: hidden;
	}
	.intro-shell.collapsed,
	.discovery-reveal {
		grid-template-rows: 0fr;
		opacity: 0;
	}
	.discovery-reveal.expanded {
		grid-template-rows: 1fr;
		opacity: 1;
	}
	header {
		transition: margin-bottom 800ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.in-flow header {
		margin-bottom: 40px;
	}
	.intro {
		padding: 68px 0 44px;
		text-align: center;
	}
	h1 {
		font-size: clamp(38px, 6.2vw, 62px);
		font-weight: 650;
		line-height: 1.12;
		letter-spacing: -0.055em;
		text-wrap: balance;
		margin: 20px 0 28px;
	}
	.headline-word {
		white-space: nowrap;
	}
	.headline-character {
		display: inline-block;
		position: relative;
		animation: type-character 1ms step-start var(--type-delay) both;
	}
	.headline-character::after {
		content: '';
		position: absolute;
		right: -0.055em;
		top: 0.12em;
		width: 2px;
		height: 0.88em;
		background: #0066cc;
		animation: type-caret var(--caret-duration) linear var(--type-delay) both;
	}
	.headline-character.last-character::after {
		animation: finish-caret 1200ms linear var(--type-delay) both;
	}
	@keyframes type-character {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes type-caret {
		0%,
		100% {
			opacity: 0;
		}
		1%,
		99% {
			opacity: 1;
		}
	}
	@keyframes finish-caret {
		0%,
		30%,
		60%,
		100% {
			opacity: 0;
		}
		1%,
		29%,
		61%,
		89% {
			opacity: 1;
		}
		31%,
		59%,
		90% {
			opacity: 0;
		}
	}

	p {
		line-height: 1.8;
	}
	.intro > p:last-child {
		color: #6e6e73;
		font-size: 16px;
	}
	.workspace {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		max-width: 640px;
		margin: 0 auto;
		gap: 20px;
	}
	.card {
		width: 100%;
		max-width: 640px;
		margin-inline: auto;
		padding: 28px;
		background: #ffffff;
		border: 1px solid #e5e5e7;
		box-shadow: 0 2px 8px #00000003;
		border-radius: 22px;
	}
	.card > button,
	.reconnect {
		display: block;
		margin-inline: auto;
	}
	.send-button {
		margin-top: 24px;
		min-width: 160px;
	}
	.recipient-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px 16px;
		margin-bottom: 16px;
	}
	.recipient-row .description {
		flex: 1 1 160px;
		min-width: 0;
		margin: 0;
		overflow-wrap: anywhere;
	}
	.recipient-row .text-button {
		flex-shrink: 0;
	}
	.section-heading {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 24px;
	}
	h2 {
		font-size: 18px;
		letter-spacing: -0.025em;
		margin: 0;
	}
	.picker {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: 12px;
		min-height: 190px;
		border: 1px solid transparent;
		border-radius: 14px;
		background: #f5f5f7;
		cursor: pointer;
	}
	.picker.disabled {
		opacity: 0.6;
	}
	.picker input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: inherit;
	}
	.picker > span:last-of-type {
		font-size: 12px;
		color: #6e6e73;
	}
	.photo-icon {
		font-size: 45px;
		line-height: 1;
		color: #0071e3;
	}
	.hint {
		font-size: 12px;
		color: #6e6e73;
		line-height: 1.8;
		margin: 16px 0 0;
	}
	.description {
		font-size: 14px;
		color: #6e6e73;
		margin-top: 0;
	}
	button {
		border: 1px solid #d2d2d7;
		background: transparent;
		color: #0066cc;
		padding: 11px 18px;
		border-radius: 10px;
		font-size: 13px;
		min-height: 44px;
	}
	.primary {
		background: #0071e3;
		border-color: #0071e3;
		color: #ffffff;
		font-weight: 650;
	}
	.text-button {
		border: 0;
		text-decoration: none;
		text-underline-offset: 4px;
		padding: 12px 0;
		display: block;
	}
	.file-list,
	.devices {
		list-style: none;
		margin: 20px 0 0;
		padding: 0;
	}
	.selection-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 16px;
		color: #6e6e73;
		font-size: 12px;
	}
	.clear-selection {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		flex-shrink: 0;
		padding: 0;
		border: 0;
		border-radius: 50%;
		color: #6e6e73;
	}
	.clear-selection svg {
		width: 20px;
		height: 20px;
	}
	.clear-selection:not(:disabled):hover {
		background: #f0f0f3;
		color: #1d1d1f;
	}
	.file-list {
		margin-top: 0;
	}
	.file-list li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 0;
		font-size: 12px;
		border-bottom: 1px solid #e8e8ed;
	}
	.file-list span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.file-list small {
		white-space: nowrap;
		color: #6e6e73;
	}
	.devices li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 0;
		border-bottom: 1px solid #e8e8ed;
	}
	.avatar {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		background: #f5f5f7;
		border-radius: 50%;
		font-size: 22px;
	}
	.devices li > div {
		flex: 1;
	}
	.devices strong {
		font-size: 14px;
	}
	.devices small {
		display: block;
		font-size: 11px;
		color: #6e6e73;
		margin-top: 5px;
	}
	.alert {
		width: 100%;
		max-width: 640px;
		margin-inline: auto;
		overflow-wrap: anywhere;
		padding: 16px 20px;
		margin-bottom: 20px;
		border-radius: 12px;
		background: #edf4fc;
		font-size: 14px;
		line-height: 1.7;
	}
	.alert.error {
		background: #fff0ef;
		color: #b42318;
	}
	.reconnect {
		margin-bottom: 20px;
	}
	.transfer,
	.received {
		margin-top: 20px;
	}
	.actions {
		display: flex;
		justify-content: center;
		gap: 12px;
		flex-wrap: wrap;
		margin: 20px 0;
	}

	.gallery {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 20px;
		margin-top: 24px;
	}
	figure {
		flex: 0 1 180px;
		margin: 0;
		min-width: 0;
	}
	figure img,
	.no-preview {
		width: 100%;
		height: 180px;
		object-fit: cover;
		border-radius: 12px;
		background: #f5f5f7;
	}
	.no-preview {
		display: flex;
		justify-content: center;
		align-items: center;
		flex-direction: column;
		font-size: 13px;
		color: #6e6e73;
	}
	figcaption {
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: 12px;
		padding: 4px 0 12px;
	}
	figcaption button {
		padding: 12px 8px;
		font-size: 12px;
	}
	figcaption a {
		text-align: center;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	a {
		color: #0066cc;
	}
	footer {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		margin-top: 28px;
		padding: 8px 0 16px;
		font-size: 11px;
		letter-spacing: 0.045em;
		line-height: 1.7;
		color: #6e6e73;
	}
	.photo-icon svg {
		width: 48px;
		height: 48px;
	}
	.avatar svg {
		width: 22px;
		height: 22px;
	}
	.card,
	.devices li > div {
		min-width: 0;
	}
	.devices strong,
	.badge {
		overflow-wrap: anywhere;
	}
	.primary:not(:disabled):hover {
		background: #0077ed;
	}
	button:not(:disabled):active {
		transform: scale(0.98);
	}
	.picker:not(.disabled):hover {
		background: #ededf0;
	}
	.picker strong {
		color: #0066cc;
		font-size: 15px;
		font-weight: 500;
	}
	button,
	.picker {
		transition:
			background 150ms ease,
			transform 150ms ease;
	}
	@media (prefers-reduced-motion: reduce) {
		.intro-shell,
		.discovery-reveal,
		header {
			transition: none;
		}
		.headline-character {
			animation: none;
		}
		.headline-character::after {
			display: none;
			animation: none;
		}
		button,
		.picker {
			transition: none;
		}
		button:not(:disabled):active {
			transform: none;
		}
	}
	@media (max-width: 640px) {
		main {
			padding-top: 24px;
		}
		.intro {
			padding-top: 44px;
		}
		.workspace {
			grid-template-columns: 1fr;
		}
		.card {
			padding: 22px;
		}
		.badge {
			font-size: 11px;
		}
		.gallery figure {
			flex-basis: calc((100% - 20px) / 2);
		}
		figure img,
		.no-preview {
			height: 140px;
		}
	}
</style>
