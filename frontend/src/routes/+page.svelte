<script lang="ts">
	import { onMount } from 'svelte';
	import DropView from '$lib/components/DropView.svelte';
	import PasskeyAccount from '$lib/components/PasskeyAccount.svelte';
	import { createDropController } from '$lib/drop/controller.svelte';

	let senderAuthenticated = $state(false);
	let input = $state<HTMLInputElement>();
	let transferSection = $state<HTMLElement>();
	let receivedSection = $state<HTMLElement>();
	const drop = createDropController({
		clearSelection: () => {
			if (input) {
				input.value = '';
			}
		},
		showTransfer: () => transferSection?.scrollIntoView({ block: 'center' }),
		showReceived: () => receivedSection?.scrollIntoView({ block: 'start' })
	});
	onMount(drop.mount);
</script>

{#snippet accountControls()}
	<PasskeyAccount bind:authenticated={senderAuthenticated} />
{/snippet}

<DropView
	{...drop}
	{accountControls}
	{senderAuthenticated}
	bind:input
	bind:transferSection
	bind:receivedSection
	connect={drop.incomingToken ? drop.joinLink : drop.createLink}
/>
