<script lang="ts">
	import { isHeic, type ConversionMode } from '../../../../shared/photos.ts';
	import type { ReceivedPhoto } from '#lib/photos/received.ts';
	import { formatBytes } from '#lib/photos/index.ts';

	let {
		photo,
		previewFailed,
		convert,
		shareJpeg,
		checkExpiry
	}: {
		photo: ReceivedPhoto;
		previewFailed: () => void;
		convert: (mode: ConversionMode) => void;
		shareJpeg: () => void;
		checkExpiry: () => boolean;
	} = $props();

	function download(event: MouseEvent) {
		if (!checkExpiry()) {
			event.preventDefault();
		}
	}
</script>

<figure aria-label={photo.file.name}>
	{#if photo.preview}
		<img
			src={photo.previewUrl ?? photo.url}
			alt={photo.file.name}
			onerror={previewFailed}
		/>
	{:else}
		<div class="no-preview">
			プレビューなし<small>元の写真は保存できます</small>
		</div>
	{/if}
	<figcaption>
		<a
			class="original"
			href={photo.url}
			download={photo.file.name}
			onclick={download}
		>
			<strong>{photo.file.name}</strong>
			<span>元の写真をダウンロード</span>
		</a>
		<p class="metadata">
			{photo.file.type.replace('image/', '').toUpperCase()} · {formatBytes(photo.file.size)}
		</p>
		{#if isHeic(photo.file.type)}
			<details>
				<summary>プレビュー・JPEG変換</summary>
				<p class="hint">
					この写真をCloudflareに送って処理します。サーバーには保存しません。JPEGでは画質が変わったり、撮影情報が引き継がれなかったりする場合があります。元の写真も保存できます。
				</p>
				{#if !photo.previewUrl}<button
						disabled={photo.busy}
						onclick={() => convert('preview')}>プレビューを表示する</button
					>{/if}
				{#if !photo.jpegUrl}<button
						disabled={photo.busy}
						onclick={() => convert('jpeg')}>JPEGに変換する</button
					>{/if}
				{#if photo.busy}<p role="status">変換中…</p>{/if}
				{#if photo.problem}<p role="status">{photo.problem}</p>{/if}
				{#if photo.jpegUrl && photo.jpeg}
					<div class="converted">
						<p>変換したJPEG</p>
						<a
							href={photo.jpegUrl}
							download={photo.jpeg.name}
							onclick={download}>JPEGをダウンロードする</a
						>
						<button onclick={shareJpeg}>JPEGを保存・共有する</button>
					</div>
				{/if}
			</details>
		{/if}
	</figcaption>
</figure>

<style>
	figure {
		min-width: 0;
		margin: 0;
		border: 1px solid #dedcd1;
		border-radius: 8px;
		overflow: hidden;
	}
	img,
	.no-preview {
		display: block;
		width: 100%;
		aspect-ratio: 1;
		max-height: 260px;
		object-fit: contain;
		background: #f4f0e7;
	}
	.no-preview {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: #6c7064;
		font-size: 13px;
	}
	small {
		font-size: 13px;
	}
	figcaption {
		padding: 12px;
		font-size: 14px;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	a {
		color: #a23d24;
	}
	.original {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 44px;
	}
	.original strong {
		color: #283f35;
		font-weight: 600;
	}
	.original span {
		font-size: 13px;
	}
	.metadata,
	.hint {
		color: #6c7064;
		font-size: 13px;
	}
	.metadata {
		margin: 8px 0 0;
	}
	details {
		margin-top: 12px;
		border-top: 1px solid #dedcd1;
	}
	summary {
		cursor: pointer;
		padding: 12px 0;
		min-height: 44px;
	}
	summary:focus-visible {
		outline: 3px solid #b64629;
		outline-offset: 2px;
	}
	button {
		width: 100%;
		margin-top: 8px;
		min-height: 44px;
		padding: 10px 6px;
		border: 1px solid #cdcbbc;
		border-radius: 6px;
		background: transparent;
		color: #a23d24;
		font-size: 14px;
	}
	button:not(:disabled):hover {
		background: #ece8dc;
	}
	.converted {
		border-top: 1px solid #dedcd1;
		margin-top: 12px;
	}
</style>
