<script>
	import { onMount } from 'svelte';
	import { photos } from '../../../data';

	let ready = $state(false);
	let selected = $state(false);
	let progress = $state(0);
	onMount(() => {
		ready = true;
	});
</script>

<main data-ready={ready}>
	<h1>Pico Drop</h1>
	<p>写真を選んで、相手に共有します。</p>
	<button
		disabled={!ready}
		onclick={() => (selected = !selected)}>写真を選択</button
	>
	<ul>
		{#if selected}{#each photos as photo (photo.name)}<li>
					<span>{photo.name}</span><small>{photo.size}</small>
				</li>{/each}{/if}
	</ul>
	<button
		disabled={!ready}
		onclick={() => progress++}>進捗を更新</button
	><progress
		value={progress}
		max={100}
	></progress><output>{progress}</output><a href="/details">共有の説明</a>
</main>
