<script lang="ts">
	let { locating = false } = $props<{ locating?: boolean }>();
</script>

<div class="discovery">
	<div class="scene" aria-hidden="true">
		<div class="halo"></div>
		<div class="ripple"></div>
		<div class="ripple second"></div>
		<div class="ripple third"></div>
		<div class="source"><span></span></div>
	</div>
	<p role="status">{locating ? '現在地を確認しています' : '近くの人を探しています'}</p>
	<small
		>{locating
			? '位置情報の利用を許可してください。'
			: '相手もこのページで探索を始めると、ここに表示されます。'}</small
	>
</div>

<style>
	.discovery {
		text-align: center;
		padding: 12px 0 20px;
	}
	.scene {
		position: relative;
		width: 264px;
		max-width: 100%;
		aspect-ratio: 1;
		margin: 0 auto 12px;
		display: grid;
		place-items: center;
		isolation: isolate;
	}
	.halo {
		position: absolute;
		width: 88%;
		aspect-ratio: 1;
		border-radius: 50%;
		background: radial-gradient(circle, #0071e30b 0%, #0071e305 40%, transparent 70%);
	}
	.ripple {
		position: absolute;
		width: 88%;
		aspect-ratio: 1;
		border: 1px solid #428fda;
		border-radius: 50%;
		box-shadow:
			0 0 8px #428fda08,
			inset 0 0 8px #428fda08;
		animation: expand 6s cubic-bezier(0.2, 0.45, 0.35, 1) infinite;
	}
	.second {
		animation-delay: -2s;
	}
	.third {
		animation-delay: -4s;
	}
	.source {
		position: relative;
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border: 1px solid #0071e310;
		border-radius: 50%;
		background: #ffffffb3;
		box-shadow: 0 0 22px #0071e310;
	}
	.source span {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #3988d4;
		box-shadow:
			0 0 0 4px #3988d40a,
			0 0 12px #3988d433;
		animation: breathe 4s ease-in-out infinite;
	}
	p {
		margin: 0 0 8px;
		color: #1d1d1f;
		font-size: 15px;
		font-weight: 500;
		line-height: 1.6;
	}
	small {
		display: block;
		color: #6e6e73;
		font-size: 12px;
		line-height: 1.8;
		max-width: 300px;
		margin: auto;
	}
	@keyframes expand {
		0% {
			transform: scale(0.12);
			opacity: 0;
		}
		15% {
			opacity: 0.36;
		}
		55% {
			opacity: 0.18;
		}
		100% {
			transform: scale(1);
			opacity: 0;
		}
	}
	@keyframes breathe {
		0%,
		100% {
			opacity: 0.65;
			transform: scale(0.9);
		}
		50% {
			opacity: 1;
			transform: scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ripple,
		.source span {
			animation: none;
		}
		.ripple {
			transform: scale(0.38);
			opacity: 0.25;
		}
		.second {
			transform: scale(0.65);
			opacity: 0.16;
		}
		.third {
			transform: scale(0.92);
			opacity: 0.08;
		}
	}
</style>
