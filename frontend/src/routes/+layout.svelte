<script lang="ts">
	import favicon from '$lib/assets/pico-drop-icon.png';

	let { children } = $props();
</script>

<svelte:head>
	<link
		rel="icon"
		type="image/png"
		href={favicon}
	/>
</svelte:head>

{@render children()}
