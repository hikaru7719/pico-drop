<script lang="ts">
	import qrcode from 'qrcode-generator';

	let { url }: { url: string } = $props();
	const image = $derived(makeQr(url));

	function makeQr(value: string) {
		try {
			return encodeQr(value);
		} catch {
			return undefined;
		}
	}

	function encodeQr(value: string) {
		const code = qrcode(0, 'M');
		code.addData(value);
		code.make();
		return code.createDataURL(6, 24);
	}
</script>

{#if image}
	<img
		src={image}
		alt="写真を受け取るためのQRコード"
		width="280"
		height="280"
	/>
{:else}
	<p role="status">
		QRコードを表示できませんでした。「リンクで送る」を使ってください。
	</p>
{/if}

<style>
	img {
		display: block;
		width: min(100%, 280px);
		height: auto;
		margin: 20px auto;
		image-rendering: pixelated;
		border-radius: 12px;
	}
</style>
