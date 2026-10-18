<script lang="ts">
	let { file }: { file: File } = $props();
	let url = $state('');
	let failed = $state(false);
	$effect(() => {
		const preview = URL.createObjectURL(file);
		url = preview;
		failed = false;
		return () => URL.revokeObjectURL(preview);
	});
</script>

{#if url && !failed}
	<img
		src={url}
		alt={file.name}
		onerror={() => (failed = true)}
	/>
{:else}
	<div class="placeholder"><span>写真</span><small>プレビューなし</small></div>
{/if}

<style>
	img,
	.placeholder {
		width: 100%;
		height: 76px;
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
		font-size: 10px;
	}
</style>
