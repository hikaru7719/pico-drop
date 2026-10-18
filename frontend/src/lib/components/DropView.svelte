<script lang="ts">
	import '@fontsource-variable/noto-sans-jp';
	import type { Snippet } from 'svelte';
	import type { ConversionMode } from '../../../../shared/photos.ts';
	import type { ReceivedPhoto } from '$lib/photos/received';
	import TransferProgress from './TransferProgress.svelte';
	import ShareQr from './ShareQr.svelte';
	import PhotoPost from './PhotoPost.svelte';
	import PhotoSelection from './PhotoSelection.svelte';
	import ReceivedPhotoCard from './ReceivedPhotoCard.svelte';
	import { formatBytes } from '$lib/photos';
	import type {
		PhotoMeta,
		ServerMessage,
		Session
	} from '../../../../shared/protocol';
	type Props = {
		accountControls?: Snippet;
		senderAuthenticated?: boolean;
		incomingToken?: string;
		invitationUsed?: boolean;
		addPhotos?: (files: File[]) => void;
		restartSharing?: (keepPhotos: boolean) => void;
		shareLink?: string;
		linkExpiresAt?: number;
		creatingLink?: boolean;
		createLink?: () => void;
		revokeLink?: () => void;
		shareInvitation?: () => void;
		copyInvitation?: () => void;
		flowStarted?: boolean;
		session?: Session | undefined;
		connection?: 'idle' | 'connecting' | 'online' | 'offline';
		selected?: File[];
		metadata?: PhotoMeta[];
		selecting?: boolean;
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
		select?: (files: File[]) => void;
		removePhoto?: (index: number) => void;
		previewFailed?: (index: number) => void;
		action?: (type: 'accept' | 'reject' | 'cancel') => void;
		save?: () => void;
		discard?: () => void;
	};
	let {
		accountControls,
		senderAuthenticated = false,
		incomingToken = '',
		invitationUsed = false,
		addPhotos = () => {},
		restartSharing = () => {},
		shareLink = '',
		linkExpiresAt,
		creatingLink = false,
		createLink = () => {},
		revokeLink = () => {},
		shareInvitation = () => {},
		copyInvitation = () => {},
		flowStarted = false,
		session = undefined,
		connection = 'idle',
		selected = [],
		metadata = [],
		selecting = false,
		request = undefined,
		phase = 'waiting',
		bytes = 0,
		received = [],
		completed = false,
		notice = '',
		error = '',
		relay = undefined,
		sharing = false,
		input = $bindable(undefined),
		transferSection = $bindable(undefined),
		receivedSection = $bindable(undefined),
		connect = () => {},
		select = () => {},
		removePhoto = () => {},
		previewFailed = () => {},
		action = () => {},
		save = () => {},
		photosExpireAt,
		convertPhoto = () => {},
		shareJpeg = () => {},
		checkPhotoExpiry = () => true,
		discard = () => {}
	}: Props = $props();
	let started = $state(false);
	const inFlow = $derived(
		started ||
			flowStarted ||
			selected.length > 0 ||
			!!shareLink ||
			!!incomingToken ||
			!!request ||
			completed ||
			received.length > 0
	);
	$effect(() => {
		if (inFlow) {
			started = true;
		}
	});
	const headline = '目の前の人に、写真を。';
	const typingInterval = 180;
	const headlineCycle = 250 + (headline.length - 1) * typingInterval + 3000;
	let headlineReplay = $state(0);
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

	const headlineWords = headline
		.match(/[^、。]+[、。]?/g)!
		.map((word, index, words) => ({
			word,
			offset: words.slice(0, index).join('').length
		}));

	const sent = $derived(
		completed && !received.length && !request && !incomingToken
	);
	const receiverStopped = $derived(
		!!incomingToken &&
			!request &&
			(connection === 'idle' || connection === 'offline')
	);
	const sending = $derived(!!request && request.from.id === session?.id);
	const total = $derived(
		request?.files.reduce((sum, f) => sum + f.size, 0) ?? 0
	);
</script>

<svelte:head>
	<title>Pico Drop — リンクで写真を共有</title>
	<meta
		name="description"
		content="リンクひとつで写真を共有。受け取る人のログインは不要です。"
	/>
</svelte:head>

<main class:in-flow={inFlow}>
	<header>
		<a
			class="brand"
			href="/"
			aria-label="Pico Drop ホーム"
			><svg
				class="brand-icon"
				viewBox="0 0 32 32"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				aria-hidden="true"
				><rect
					x="4"
					y="8"
					width="19"
					height="20"
					rx="4"
				/><path d="m8 21 5-5 6 6M14 4h10a4 4 0 0 1 4 4v12" /><circle
					cx="10"
					cy="13"
					r="1"
				/></svg
			><span
				class="wordmark"
				aria-hidden="true">Pico Drop</span
			></a
		>
		<div
			class="identity"
			role="status"
		>
			<span class="identity-label"
				>{connection === 'online' ? 'この端末の名前' : '共有の状態'}</span
			>
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
							? completed
								? '受け渡し完了'
								: receiverStopped
									? '受け取り終了'
									: '写真を選んで共有'
							: '接続できませんでした'}</span
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
				<PhotoPost />
				<p class="eyebrow">A LITTLE PHOTO DELIVERY</p>
				<h1 aria-label={headline}>
					{#key headlineReplay}
						{#each headlineWords as { word, offset }}<span
								class="headline-word"
								aria-hidden="true"
								>{#each [...word] as character, index}<span
										class="headline-character"
										class:last-character={offset + index ===
											headline.length - 1}
										style={`--type-delay: ${250 + (offset + index) * typingInterval}ms; --caret-duration: ${index === word.length - 1 && offset + index < headline.length - 1 ? typingInterval * 2 : typingInterval}ms`}
										>{character}</span
									>{/each}</span
							>{/each}
					{/key}
				</h1>
				<p>写真を選んで、QRで渡す。<br />受け取りはログイン不要です。</p>
				<div
					class="sharing-guide"
					aria-label="写真を共有する流れ"
				>
					<span>{senderAuthenticated ? '写真を選ぶ' : 'ログイン・登録'}</span
					><span aria-hidden="true">→</span><span
						>{senderAuthenticated ? 'QRを見せる' : '写真を選ぶ'}</span
					><span aria-hidden="true">→</span><span
						>{senderAuthenticated ? '相手が受け取る' : 'QRで渡す'}</span
					>
				</div>
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
	{#if connection === 'offline' && incomingToken && !invitationUsed}<button
			class="primary reconnect"
			onclick={connect}>再接続する</button
		>{/if}
	{#if sent}
		<section
			class="card sent"
			aria-labelledby="sent-heading"
		>
			<h2 id="sent-heading">送信完了</h2>
			<p role="status">
				すべての写真が相手の端末に届きました。元の写真と同じデータであることも確認できました。
			</p>
			<PhotoSelection files={selected} />
			<p class="hint">相手の端末への保存は、受け取った人が行います。</p>
			<div class="next-actions">
				<button
					class="primary"
					onclick={() => restartSharing(true)}>同じ写真をもう一度共有</button
				>
				<button onclick={() => restartSharing(false)}>別の写真を選ぶ</button>
			</div>
		</section>
	{/if}
	{#if !request && !completed}
		<div class="workspace">
			{#if receiverStopped}
				<section
					class="card"
					aria-labelledby="ended-heading"
				>
					<h2 id="ended-heading">受け取りは終了しました</h2>
					<p class="description">
						もう一度受け取るには、送る人に新しいQR・共有リンクを作ってもらってください。
					</p>
					<a
						class="home-link"
						href="/">自分も写真を送る</a
					>
				</section>
			{:else if incomingToken}
				<section class="card">
					<h2>共有リンクから写真を受け取る</h2>
					<p class="description">
						相手の名前と写真の枚数・容量を確認してから、受け取るかどうかを選べます。「受け取る」を押すまで写真は転送されません。
					</p>
					{#if connection === 'connecting' || connection === 'online'}
						<p role="status">共有内容を確認中…</p>
					{/if}
					<p class="hint">
						接続できない場合はSafariやChromeでリンクを開いてください。
					</p>
				</section>
			{:else if shareLink}
				<section class="card">
					<h2>今回の共有</h2>
					<PhotoSelection files={selected} />
					<h3>相手にQRを見せる</h3>
					<p class="description">
						相手のスマートフォンのカメラで読み取って、表示されたリンクを開いてもらってください。
					</p>
					<ShareQr url={shareLink} />
					<p class="hint">
						相手が「受け取る」を押すまで、写真は送られません。転送が終わるまで、お互いに画面を開いたままにしてください。
					</p>
					<details>
						<summary>リンクで送る</summary>
						<label
							>共有リンク<input
								class="share-link"
								aria-label="共有リンク"
								readonly
								value={shareLink}
								onclick={(event) => event.currentTarget.select()}
							/></label
						>

						<div class="actions">
							<button onclick={shareInvitation}>LINEなどで共有する</button
							><button onclick={copyInvitation}>リンクをコピーする</button>
						</div>
					</details>
					<p class="hint">
						共有の有効期限：{linkExpiresAt
							? new Date(linkExpiresAt).toLocaleTimeString('ja-JP')
							: ''}（作成から10分）。相手が接続すると、このリンクは使えなくなります。
					</p>
					<button
						class="text-button"
						onclick={revokeLink}>共有を取り消す</button
					>
				</section>
			{:else}
				<section
					class="card photos"
					aria-labelledby={senderAuthenticated ? 'photos-heading' : undefined}
					aria-label={senderAuthenticated
						? undefined
						: '写真を送るためのログイン・新規登録'}
				>
					{@render accountControls?.()}
					{#if senderAuthenticated}
						<h2 id="photos-heading">今回の共有</h2>
						<p class="section-description">
							{selected.length
								? 'この写真を、相手に渡します。'
								: '渡したい写真を、この端末から選んでください。'}
						</p>
						{#if selected.length}
							<PhotoSelection
								files={selected}
								editable
								disabled={selecting || creatingLink}
								remove={removePhoto}
							/>
						{/if}
						<label
							class:disabled={!!request || selecting || creatingLink}
							class:has-selection={selected.length > 0}
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
										? '写真を追加'
										: '写真を選ぶ'}</strong
							><span
								>{selected.length
									? '選んだ写真を残して、合計10枚・50MBまで'
									: '10枚まで・合計50MBまで'}</span
							><input
								bind:this={input}
								type="file"
								accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
								multiple
								disabled={!!request || selecting || creatingLink}
								onchange={(event) =>
									addPhotos(Array.from(event.currentTarget.files ?? []))}
							/></label
						>

						{#if selected.length}
							<label class="replace-picker"
								>すべて選び直す<input
									type="file"
									aria-label="すべて選び直す"
									accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
									multiple
									disabled={selecting || creatingLink}
									onchange={(event) => {
										const files = Array.from(event.currentTarget.files ?? []);
										if (files.length) {
											select(files);
										}
										event.currentTarget.value = '';
									}}
								/></label
							>
						{/if}
						<p class="hint">
							元の画質で送ります。写真に含まれる撮影場所などの情報も、そのまま相手に渡ります。
						</p>
						<button
							class="primary send-button"
							disabled={!senderAuthenticated ||
								!metadata.length ||
								selecting ||
								creatingLink ||
								connection === 'connecting'}
							onclick={() => {
								started = true;
								createLink();
							}}
							>{creatingLink || connection === 'connecting'
								? 'QRを準備中…'
								: '写真を渡す'}</button
						>
						<p class="hint sharing-note">
							QRは10分間・1人だけ有効です。受け取る人のログインや位置情報の許可は不要です。
						</p>
					{/if}
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
					? `${request.to.name}に写真を送る`
					: `${request.from.name}から写真を受け取る`}
			</h2>
			{#if sending}
				<PhotoSelection files={selected} />
			{:else}
				<p>{request.files.length}枚 · {formatBytes(total)}</p>
			{/if}
			{#if phase === 'waiting'}
				<p>
					{sending
						? '相手が「受け取る」を押すのを待っています。写真はまだ送信していません。'
						: 'この相手から写真を受け取りますか？受け取ると転送が始まります。'}
				</p>
				{#if !sending}<div class="actions">
						<button
							class="primary"
							onclick={() => action('accept')}>受け取る</button
						><button onclick={() => action('reject')}>受け取らない</button>
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
						現在の接続方法では、お使いのネットワークによって写真を送れない場合があります。
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
			<!-- svelte-ignore a11y_no_noninteractive_tabindex (Allow keyboard scrolling of received photos.) -->
			<div
				class="gallery"
				role="region"
				aria-label="受け取った写真"
				tabindex="0"
			>
				{#each received as item, index (item.file)}
					<ReceivedPhotoCard
						photo={item}
						previewFailed={() => previewFailed(index)}
						convert={(mode) => convertPhoto(index, mode)}
						shareJpeg={() => shareJpeg(index)}
						checkExpiry={checkPhotoExpiry}
					/>
				{/each}
			</div>
			{#if received.length > 1}<p class="gallery-hint">
					横にスクロールして、1枚ずつ確認できます。
				</p>{/if}
			<div class="save-collection">
				<button
					class="primary"
					disabled={sharing}
					onclick={save}>写真を保存・共有する</button
				>
				<p class="hint">
					{received.length > 1
						? `全${received.length}枚をまとめて保存。`
						: ''}iPhoneでは「画像を保存」を選んでください。
				</p>
			</div>
			<div class="expiry-note">
				{#if photosExpireAt}<strong
						>保存できる期限：{new Date(photosExpireAt).toLocaleTimeString(
							'ja-JP'
						)}</strong
					>{/if}
				<p>
					受信から10分たつか、このページを閉じると、画面内の写真は削除されます。端末に保存した写真は残ります。
				</p>
			</div>
			<div class="discard-collection">
				<p class="hint">端末に保存できたことを確認してから削除してください。</p>
				<button
					class="text-button"
					onclick={discard}>画面内の写真を削除する</button
				>
			</div>
		</section>
	{/if}
	<footer>
		<span
			class="footer-mark"
			aria-hidden="true">Pico Drop /</span
		><span>写真はサーバーに保存されません</span>
	</footer>
</main>

<style>
	.next-actions {
		display: grid;
		gap: 12px;
		margin-top: 24px;
	}
	.home-link {
		display: inline-block;
		padding: 12px 0;
	}
	.replace-picker {
		position: relative;
		display: block;
		width: fit-content;
		margin: 8px auto 0;
		padding: 12px;
		font-size: 14px;
		color: #a23d24;
		cursor: pointer;
	}
	.replace-picker input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: inherit;
	}
	.replace-picker:focus-within,
	.gallery:focus-visible {
		outline: 3px solid #b64629;
		outline-offset: 4px;
	}
	:global(body) {
		background-image: radial-gradient(#837f6820 0.6px, transparent 0.6px);
		background-size: 7px 7px;
	}
	.intro > .eyebrow {
		font-family: ui-monospace, monospace;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.18em;
		color: #88664c;
		margin: 0 0 16px;
	}
	.footer-mark {
		font-weight: 700;
		letter-spacing: -0.03em;
		color: #283f35;
	}
	.brand-icon {
		background: #b64629;
		color: #fffdf8;
		padding: 5px;
		border-radius: 9px 9px 9px 2px;
		box-sizing: content-box;
	}
	.sharing-guide {
		padding-top: 20px;
		border-top: 1px solid #dedcd1;
		width: fit-content;
		margin-inline: auto;
	}
	.picker .photo-icon {
		transform: rotate(-6deg);
	}
	@media (min-width: 801px) {
		main:not(.in-flow):not(:has(.alert)) {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
			column-gap: 64px;
			align-items: start;
		}
		main:not(.in-flow):not(:has(.alert)) header {
			grid-column: 1 / -1;
			width: 100%;
			max-width: none;
			margin-bottom: 56px;
			padding-bottom: 24px;
			border-bottom: 1px solid #dedcd1;
		}
		main:not(.in-flow):not(:has(.alert)) footer {
			grid-column: 1 / -1;
		}
		main:not(.in-flow):not(:has(.alert)) .workspace {
			width: 100%;
		}
		.headline-word {
			display: block;
		}
	}

	.brand-icon {
		width: 32px;
		height: 32px;
		margin-right: 10px;
	}
	.sharing-guide {
		display: flex;
		justify-content: center;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
		margin-top: 24px;
		font-size: 14px;
		color: #555f53;
	}
	.sharing-guide [aria-hidden] {
		color: #858875;
	}
	.section-description {
		margin: 8px 0 20px;
		font-size: 14px;
		color: #6c7064;
	}
	.picker.has-selection {
		border-style: solid;
	}
	.sharing-note {
		text-align: center;
	}
	h2 {
		overflow-wrap: anywhere;
		line-height: 1.5;
	}
	summary:focus-visible,
	.share-link:focus-visible {
		outline: 3px solid #b64629;
		outline-offset: 4px;
	}
	details {
		margin-top: 20px;
		border-block: 1px solid #dedcd1;
		font-size: 14px;
	}

	summary {
		cursor: pointer;
		padding: 12px 0;
	}

	.share-link {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		margin-top: 12px;
		padding: 12px;
	}
	:global(body) {
		margin: 0;
		background-color: #f4f0e7;
		color: #283f35;
		font-family:
			'Noto Sans JP Variable', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN',
			'Yu Gothic', Meiryo, sans-serif;
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
		outline: 3px solid #b64629;
		outline-offset: 4px;
	}
	main {
		max-width: 1160px;
		margin: auto;
		padding: 32px clamp(20px, 4vw, 48px);
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
		color: #6c7064;
		font-size: 10px;
		letter-spacing: 0.055em;
		line-height: 1.5;
		margin-bottom: 3px;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		color: #283f35;
		text-decoration: none;
	}
	.wordmark {
		font-size: 23px;
		font-weight: 800;
		letter-spacing: -0.065em;
		line-height: 1.4;
	}
	.badge {
		display: flex;
		justify-content: flex-end;
		color: #555f53;
		align-items: center;
		gap: 8px;
		font-size: 14px;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.015em;
	}
	.dot {
		width: 5px;
		height: 5px;
		flex-shrink: 0;
		border-radius: 50%;
		background: #858875;
	}
	.dot.online {
		background: #248a3d;
	}
	.intro-shell {
		display: grid;
		grid-template-rows: 1fr;
		opacity: 1;
		transition:
			grid-template-rows 800ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 400ms ease;
	}
	.intro-clip {
		min-height: 0;
		overflow: hidden;
	}
	.intro-shell.collapsed {
		grid-template-rows: 0fr;
		opacity: 0;
	}
	header {
		transition: margin-bottom 800ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	.in-flow header {
		margin-bottom: 40px;
	}
	.intro {
		padding: 36px 0;
		text-align: center;
	}
	h1 {
		font-size: clamp(32px, 4.3vw, 50px);
		font-weight: 750;
		line-height: 1.3;
		letter-spacing: -0.045em;
		text-wrap: balance;
		margin: 16px 0 20px;
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
		background: #a23d24;
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
	.intro > p {
		color: #6c7064;
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
		background: #fffdf8;
		border: 1px solid #dedcd1;
		box-shadow:
			0 5px 0 #dedcd14d,
			0 18px 48px #283f3508;
		border-radius: 8px;
	}
	.card > button,
	.reconnect {
		display: block;
		margin-inline: auto;
	}
	.send-button {
		margin-top: 24px;
		width: 100%;
		min-height: 48px;
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
		border: 1px dashed #b8a58b;
		border-radius: 6px;
		background: #f6f0e5;
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
		font-size: 14px;
		color: #6c7064;
	}
	.photo-icon {
		font-size: 45px;
		line-height: 1;
		color: #b64629;
	}
	.hint {
		font-size: 14px;
		color: #6c7064;
		line-height: 1.8;
		margin: 16px 0 0;
	}
	.description {
		font-size: 14px;
		color: #6c7064;
		margin-top: 12px;
	}
	button {
		border: 1px solid #cdcbbc;
		background: transparent;
		color: #a23d24;
		padding: 11px 18px;
		border-radius: 6px;
		font-size: 14px;
		min-height: 44px;
	}
	.primary {
		background: #b64629;
		border-color: #b64629;
		color: #ffffff;
		font-weight: 750;
	}
	.text-button {
		border: 0;
		text-decoration: none;
		text-underline-offset: 4px;
		padding: 12px 0;
		display: block;
	}
	.alert {
		width: 100%;
		max-width: 640px;
		margin-inline: auto;
		overflow-wrap: anywhere;
		padding: 16px 20px;
		margin-bottom: 20px;
		border-radius: 12px;
		background: #eaf0e4;
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
		overflow-x: auto;
		scroll-snap-type: x proximity;
		padding-bottom: 8px;
		gap: 16px;
		margin-top: 24px;
	}
	.gallery :global(figure) {
		flex: 0 0 85%;
		scroll-snap-align: start;
	}
	.gallery :global(figure:only-child) {
		flex-basis: 100%;
	}

	.gallery-hint {
		margin: 8px 0 0;
		font-size: 13px;
		color: #6c7064;
	}
	.save-collection {
		margin: 20px 0;
	}
	.save-collection .primary {
		width: 100%;
	}
	.save-collection .hint {
		margin-top: 8px;
		text-align: center;
	}
	.expiry-note {
		padding: 12px 16px;
		background: #f4f0e7;
		border-radius: 6px;
		font-size: 14px;
		color: #555f53;
	}
	.expiry-note p {
		margin: 4px 0 0;
	}
	.discard-collection {
		margin-top: 24px;
		padding-top: 4px;
		border-top: 1px solid #dedcd1;
	}
	h3 {
		margin: 20px 0 0;
		font-size: 15px;
	}
	.picker.has-selection {
		min-height: 64px;
		gap: 4px;
		padding: 12px;
	}
	.picker.has-selection .photo-icon {
		display: none;
	}

	a {
		color: #a23d24;
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
		color: #6c7064;
	}
	.photo-icon svg {
		width: 48px;
		height: 48px;
	}
	.card {
		min-width: 0;
	}
	.badge {
		overflow-wrap: anywhere;
	}
	.primary:not(:disabled):hover {
		background: #963820;
	}
	button:not(:disabled):active {
		transform: scale(0.98);
	}
	.picker:not(.disabled):hover {
		background: #f0e6d5;
	}
	.picker strong {
		color: #a23d24;
		font-size: 16px;
		font-weight: 600;
	}
	button,
	.picker {
		transition:
			background 150ms ease,
			transform 150ms ease;
	}
	@media (prefers-reduced-motion: reduce) {
		.intro-shell,
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
			padding: 32px 0 28px;
		}
		.workspace {
			grid-template-columns: 1fr;
		}
		.card {
			padding: 24px 20px;
		}
		.badge {
			font-size: 11px;
		}
		.gallery {
			gap: 12px;
		}
	}
</style>
