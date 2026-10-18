<script lang="ts">
	import { tick } from 'svelte';
	let { file }: { file: File } = $props();
	let url = $state('');
	let failed = $state(false);
	let dialog = $state<HTMLDialogElement>();
	let previewOpen = $state(false);

	async function openPreview() {
		previewOpen = true;
		await tick();
		dialog?.showModal();
	}

	$effect(() => {
		const preview = URL.createObjectURL(file);
		url = preview;
		failed = false;
		return () => URL.revokeObjectURL(preview);
	});
</script>

{#if url && !failed}
	<button
		class="preview"
		aria-label={`${file.name}を拡大する`}
		onclick={openPreview}
	>
		<img
			src={url}
			alt={file.name}
			onerror={() => (failed = true)}
		/>
		<span>拡大</span>
	</button>
	<dialog
		bind:this={dialog}
		aria-label={`${file.name}のプレビュー`}
		onclose={() => (previewOpen = false)}
	>
		{#if previewOpen}
			<div class="preview-header">
				<p>{file.name}</p>
				<button
					class="close"
					onclick={() => dialog?.close()}>閉じる</button
				>
			</div>
			<img
				class="full-photo"
				src={url}
				alt={file.name}
			/>{/if}
	</dialog>
{:else}
	<div class="placeholder"><span>写真</span><small>プレビューなし</small></div>
{/if}

<style>
	.preview {
		position: relative;
		width: 100%;
		display: block;
		border: 0;
		padding: 0;
		border-radius: 6px;
		background: #ece8dc;
		color: #fff;
		cursor: zoom-in;
	}
	.preview span {
		position: absolute;
		right: 6px;
		bottom: 6px;
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 12px;
		background: #283f35e6;
	}
	dialog {
		width: min(900px, calc(100% - 32px));
		max-height: 90dvh;
		border: 1px solid #dedcd1;
		border-radius: 12px;
		padding: 16px;
		background: #fffdf8;
		color: #283f35;
	}
	dialog::backdrop {
		background: #15251ed9;
	}
	.preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 12px;
	}
	.preview-header p {
		margin: 0;
		overflow-wrap: anywhere;
		min-width: 0;
		font-size: 14px;
	}
	.close {
		flex-shrink: 0;
		min-height: 44px;
		padding: 8px 16px;
		border: 1px solid #cdcbbc;
		border-radius: 6px;
		background: transparent;
		color: #a23d24;
		font: inherit;
	}
	img.full-photo {
		height: auto;
		max-height: 70dvh;
		object-fit: contain;
	}
	button:focus-visible {
		outline: 3px solid #b64629;
		outline-offset: 4px;
	}

	img,
	.placeholder {
		width: 100%;
		height: 104px;
		border-radius: 6px;
		background: #ece8dc;
	}
	img {
		display: block;
		object-fit: cover;
	}
	.placeholder {
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		gap: 4px;
		color: #6c7064;
		font-size: 13px;
	}
	small {
		font-size: 12px;
	}
</style>
