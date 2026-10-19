<script lang="ts">
	import PhotoThumbnail from './PhotoThumbnail.svelte';
	import { formatBytes } from '#lib/photos/index.ts';
	let {
		files,
		editable = false,
		disabled = false,
		remove = () => {}
	}: {
		files: File[];
		editable?: boolean;
		disabled?: boolean;
		remove?: (index: number) => void;
	} = $props();
</script>

<div class="selection">
	<p class="summary">
		{files.length}枚の写真
		<span>· {formatBytes(files.reduce((sum, file) => sum + file.size, 0))}</span>
	</p>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Allow keyboard scrolling of the photo strip.) -->
	<div
		class="photo-strip"
		role="region"
		aria-label="今回の共有の写真"
		tabindex="0"
	>
		<ul>
			{#each files as file, index (file)}
				<li>
					<PhotoThumbnail {file} />
					<span
						class="name"
						title={file.name}>{file.name}</span
					>
					{#if editable}
						<button
							{disabled}
							aria-label={`${file.name}を選択から外す`}
							onclick={() => remove(index)}>外す</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
	{#if files.length > 1}<p class="scroll-hint">横にスクロールして、すべての写真を確認できます。</p>{/if}
</div>

<style>
	.selection {
		margin: 20px 0;
	}
	.summary {
		margin: 0 0 12px;
		font-size: 14px;
		font-weight: 600;
	}
	.summary span {
		color: #6c7064;
		font-size: 14px;
		font-weight: 400;
	}
	ul {
		display: flex;
		gap: 12px;
		list-style: none;
		padding: 0 0 8px;
		margin: 0;
	}
	.photo-strip {
		overflow-x: auto;
	}
	.photo-strip:focus-visible {
		outline: 3px solid #b64629;
		outline-offset: 4px;
	}
	li {
		flex: 0 0 120px;
		min-width: 0;
	}
	.name {
		display: block;
		overflow-wrap: anywhere;
		font-size: 13px;
		line-height: 1.4;
		margin-top: 6px;
	}
	button {
		width: 100%;
		min-height: 44px;
		margin-top: 4px;
		border: 1px solid #dedcd1;
		border-radius: 6px;
		background: transparent;
		color: #6c7064;
		font-size: 14px;
	}
	button:not(:disabled):hover {
		background: #ece8dc;
	}
	.scroll-hint {
		color: #6c7064;
		font-size: 13px;
		line-height: 1.6;
		margin: 6px 0 0;
	}
</style>
