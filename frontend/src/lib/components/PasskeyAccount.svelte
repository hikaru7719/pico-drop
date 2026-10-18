<script lang="ts">
	import { authApi as api } from '$lib/auth';
	import { onMount } from 'svelte';
	import {
		startRegistration,
		startAuthentication,
		browserSupportsWebAuthn
	} from '@simplewebauthn/browser';
	let { authenticated = $bindable(false) }: { authenticated?: boolean } =
		$props();
	$effect(() => {
		authenticated = !!account && !pending;
	});
	let name = $state('');
	let account = $state<{ name: string } | null>(null);
	let pending = $state(true);
	let supported = $state(false);
	let error = $state('');

	async function register() {
		const optionsJSON = await api('register/options', { name });
		const response = await startRegistration({ optionsJSON });
		account = (await api('register/verify', response)).account;
	}

	async function login() {
		const optionsJSON = await api('login/options');
		const response = await startAuthentication({ optionsJSON });
		account = (await api('login/verify', response)).account;
	}

	async function logout() {
		account = (await api('logout')).account;
	}

	function begin() {
		pending = true;
		error = '';
	}

	async function run(action: () => Promise<void>) {
		begin();
		try {
			await action();
		} catch (cause) {
			error = authError(cause);
		} finally {
			pending = false;
		}
	}

	function authError(cause: unknown) {
		return cause instanceof Error && cause.name === 'NotAllowedError'
			? 'パスキーの操作が完了しませんでした。もう一度お試しください。'
			: cause instanceof Error
				? cause.message
				: '認証できませんでした。';
	}

	async function restore() {
		account = (await api('status')).account;
	}

	onMount(() => {
		supported = browserSupportsWebAuthn();
		void run(restore);
	});
</script>

<section
	class="account"
	aria-label="送信者のログイン"
>
	{#if account}
		<p role="status">{account.name} としてログイン中</p>
		<button
			disabled={pending}
			onclick={() => run(logout)}>ログアウト</button
		>
	{:else}
		<h2>パスキーで続ける</h2>
		<p>写真を送るにはログインが必要です。受け取る人の登録は不要です。</p>
		<button
			disabled={pending || !supported}
			onclick={() => run(login)}>パスキーでログイン</button
		>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void run(register);
			}}
		>
			<label
				>初めての方は表示名を入力<input
					bind:value={name}
					required
					maxlength="40"
					autocomplete="nickname"
					placeholder="ニックネーム"
					disabled={pending}
				/></label
			>
			<button disabled={pending || !supported || !name.trim()}
				>パスキーを作成してはじめる</button
			>
		</form>
		<p class="hint">
			顔・指紋・端末の画面ロックで確認します。本名・メール・パスワードは不要です。パスキーを失うと同じアカウントに戻れないため、保存先の同期を確認してください。
		</p>
		{#if !supported && !pending}<p>
				このブラウザではパスキーを利用できません。SafariやChromeなどの対応ブラウザで開いてください。
			</p>{/if}
	{/if}
	{#if pending}<p role="status">認証を確認中…</p>{/if}
	{#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
	.account {
		max-width: 52rem;
		margin: 1.5rem auto;
		padding: 1.25rem;
		border: 1px solid #ddd;
		border-radius: 1rem;
		background: #fff;
		color: #292929;
	}
	h2 {
		font-size: 1.2rem;
		margin: 0 0 0.75rem;
	}
	p {
		line-height: 1.7;
	}
	form,
	label {
		display: grid;
		gap: 0.75rem;
	}
	form {
		margin-top: 1.25rem;
	}
	button,
	input {
		font: inherit;
		padding: 0.75rem 1rem;
		border: 1px solid #bbb;
		border-radius: 0.6rem;
	}
	button {
		cursor: pointer;
		background: #f5f2ed;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.hint {
		font-size: 0.85rem;
		color: #555;
	}
	[role='alert'] {
		color: #a12424;
	}
</style>
