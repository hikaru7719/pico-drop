<script lang="ts">
	import { LIMITS, type GroupParticipant } from '../../../../shared/protocol';
	import ShareQr from './ShareQr.svelte';

	let {
		participants,
		shareLink,
		linkExpiresAt,
		groupAction,
		revokeLink,
		copyInvitation,
		shareInvitation
	}: {
		participants: GroupParticipant[];
		shareLink: string;
		linkExpiresAt?: number;
		groupAction: (type: 'approve' | 'cancel', id: string) => void;
		revokeLink: () => void;
		copyInvitation: () => void;
		shareInvitation: () => void;
	} = $props();
	const labels = {
		waiting: '確認・承諾待ち',
		queued: '順番待ち',
		transferring: '転送中',
		complete: '受信完了',
		failed: '失敗',
		declined: '辞退・中止'
	};
</script>

<section
	class="group"
	aria-labelledby="group-heading"
>
	<h2 id="group-heading">みんなに渡す</h2>
	<p>
		同じQRから最大{LIMITS.participants}人が参加できます。確認・承諾がそろった人から1人ずつ送ります。
	</p>
	{#if shareLink}
		<ShareQr url={shareLink} />
		<details>
			<summary>リンクで送る</summary>
			<label
				>共有リンク<input
					aria-label="共有リンク"
					readonly
					value={shareLink}
					onclick={(event) => event.currentTarget.select()}
				/></label
			>
			<div class="actions">
				<button onclick={shareInvitation}>LINEなどで共有する</button><button onclick={copyInvitation}>リンクをコピーする</button>
			</div>
		</details>
		<p class="hint">
			期限：{linkExpiresAt
				? new Date(linkExpiresAt).toLocaleTimeString('ja-JP')
				: ''}。配布終了・期限切れで、待機中と転送中の受け渡しも終了します。
		</p>
	{:else}
		<p role="status">配布は終了しました。</p>
	{/if}
	<h3>参加者（{participants.length}/{LIMITS.participants}人）</h3>
	<p class="hint">相手の画面の確認コードを確かめてから「この相手に渡す」を押してください。表示名だけでは本人を確認できません。</p>
	<ul
		aria-label="参加者一覧"
		aria-live="polite"
	>
		{#each participants as participant (participant.id)}
			<li>
				<strong>{participant.device.name}</strong>
				<code>{participant.id.slice(0, 8).toUpperCase()}</code>
				<p>
					{labels[participant.status]}{participant.status === 'waiting'
						? `（送信者：${participant.approved ? '確認済み' : '未確認'}／受信者：${participant.accepted ? '承諾済み' : '未承諾'}）`
						: ''}
				</p>
				{#if shareLink && ['waiting', 'queued', 'transferring'].includes(participant.status)}
					<div class="actions">
						{#if !participant.approved}<button
								class="primary"
								onclick={() => groupAction('approve', participant.id)}>この相手に渡す</button
							>{/if}
						<button onclick={() => groupAction('cancel', participant.id)}>この相手への送信を中止</button>
					</div>
				{/if}
			</li>
		{/each}
	</ul>
	{#if !participants.length}<p>参加者を待っています。</p>{/if}
	<p class="hint">
		送信通信量はおおよそ写真の容量×人数分で、再送分も加算されます。全員の受信が終わるまで、この画面を開いたままにしてください。受信完了後の端末への保存は、受け取った人が行います。
	</p>
	<p class="hint">
		転送に失敗した人は、接続が続いていれば同じ受信画面から2回まで再参加できます。その都度、相手の確認と受信の承諾が必要です。
	</p>
	{#if shareLink}<button onclick={revokeLink}>配布を終了する</button>{/if}
</section>

<style>
	.group {
		max-width: 640px;
		margin: 0 auto 20px;
		padding: 28px;
		border: 1px solid #dedcd1;
		border-radius: 8px;
		background: #fffdf8;
	}
	h2 {
		font-size: 18px;
		margin-top: 0;
	}
	h3 {
		font-size: 16px;
	}
	p {
		line-height: 1.8;
	}
	.hint {
		font-size: 14px;
		color: #6c7064;
	}
	ul {
		padding: 0;
		list-style: none;
	}
	li {
		padding: 16px 0;
		border-bottom: 1px solid #dedcd1;
		overflow-wrap: anywhere;
	}
	li p {
		margin: 8px 0;
	}
	code {
		margin-left: 8px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}
	button {
		min-height: 44px;
		padding: 10px 14px;
		border: 1px solid #cdcbbc;
		border-radius: 6px;
		color: #a23d24;
		background: transparent;
	}
	.primary {
		background: #b64629;
		color: white;
		border-color: #b64629;
	}
	input {
		display: block;
		width: 100%;
		margin-top: 8px;
		padding: 10px;
	}
	@media (max-width: 640px) {
		.group {
			padding: 24px 20px;
		}
	}
</style>
