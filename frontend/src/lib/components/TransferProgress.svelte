<script lang="ts">
	import { formatBytes } from '#lib/photos/index.ts';

	let {
		bytes,
		total,
		connecting = false,
		sending = true
	}: {
		bytes: number;
		total: number;
		connecting?: boolean;
		sending?: boolean;
	} = $props();
	const transferred = $derived(Math.max(0, Math.min(bytes, total)));
	const percent = $derived(total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 0);
	const verifying = $derived(!connecting && total > 0 && transferred === total);
	const status = $derived(
		connecting ? '接続を準備しています' : verifying ? '写真を確認しています' : sending ? '写真を送信中' : '写真を受信中'
	);
</script>

<div
	class="transfer-progress"
	class:connecting
	class:verifying
>
	<div class="progress-heading">
		<div class="progress-copy">
			<p
				class="status"
				role="status"
			>
				{status}
			</p>
			<p class="detail">
				{connecting
					? '相手の端末に接続しています'
					: verifying
						? 'すべてのデータが届いたか確認しています'
						: sending
							? '元の画質のまま、相手の端末へ'
							: '元の画質のまま、この端末へ'}
			</p>
		</div>
		<div
			class="percentage"
			aria-hidden="true"
		>
			{#if connecting}<span class="waiting">—</span>{:else}{percent}<span class="unit">%</span>{/if}
		</div>
	</div>
	<div
		class="track"
		role="progressbar"
		aria-label={status}
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={connecting ? undefined : percent}
		aria-valuetext={connecting
			? '接続準備中'
			: verifying
				? '100%、データを確認中'
				: `${percent}%、${formatBytes(transferred)} / ${formatBytes(total)}`}
	>
		<div
			class="fill"
			style:width={connecting ? '32%' : `${percent}%`}
		>
			<span class="light"></span>
		</div>
	</div>
	<div class="progress-caption">
		<span>{connecting ? '転送開始までお待ちください' : verifying ? 'あと少しで完了です' : '転送済み'}</span>
		<span class="bytes">{connecting ? formatBytes(total) : `${formatBytes(transferred)} / ${formatBytes(total)}`}</span>
	</div>
</div>

<style>
	.transfer-progress {
		margin: 28px 0 24px;
		padding: 24px;
		border-radius: 18px;
		background: #f4f0e7;
	}
	.progress-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 22px;
	}
	.progress-copy {
		min-width: 0;
	}
	.status {
		margin: 0;
		color: #283f35;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.6;
	}
	.detail {
		margin: 5px 0 0;
		color: #6c7064;
		font-size: 12px;
		line-height: 1.7;
	}
	.percentage {
		color: #a23d24;
		font-size: clamp(36px, 7vw, 48px);
		font-weight: 500;
		line-height: 1;
		letter-spacing: -0.055em;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.unit {
		font-size: 18px;
		letter-spacing: 0;
		margin-left: 4px;
		color: #88664c;
	}
	.waiting {
		color: #a4a18e;
	}
	.track {
		height: 8px;
		border-radius: 99px;
		background: #e2dfd3;
		overflow: hidden;
	}
	.fill {
		height: 100%;
		position: relative;
		overflow: hidden;
		border-radius: inherit;
		background: linear-gradient(90deg, #a23d24, #d47748);
		transition: width 300ms cubic-bezier(0.2, 0.7, 0.3, 1);
	}
	.light {
		position: absolute;
		inset: 0;
		background: linear-gradient(100deg, transparent 25%, #ffffff55 50%, transparent 75%);
		transform: translateX(-100%);
		animation: sheen 2.6s ease-in-out infinite;
	}
	.connecting .fill {
		animation: connect 2s ease-in-out infinite;
	}
	.connecting .light {
		display: none;
	}
	.progress-caption {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		margin-top: 12px;
		font-size: 11px;
		color: #6c7064;
		line-height: 1.6;
	}
	.bytes {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	@keyframes sheen {
		0%,
		15% {
			transform: translateX(-100%);
		}
		80%,
		100% {
			transform: translateX(100%);
		}
	}
	@keyframes connect {
		0%,
		100% {
			transform: translateX(-100%);
		}
		50% {
			transform: translateX(312.5%);
		}
	}
	@media (max-width: 400px) {
		.transfer-progress {
			padding: 20px 16px;
		}
		.progress-heading {
			gap: 12px;
		}
		.detail {
			font-size: 11px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}
		.light {
			animation: none;
			display: none;
		}
		.connecting .fill {
			animation: none;
			transform: translateX(106%);
		}
	}
</style>
