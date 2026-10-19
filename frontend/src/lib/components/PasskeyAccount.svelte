<script lang="ts">
	import { authApi as api } from '#lib/auth.ts';
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
		const optionsJSON = await api.registerOptions(name);
		const response = await startRegistration({ optionsJSON });
		account = (await api.registerVerify(response)).account;
	}

	async function login() {
		const optionsJSON = await api.loginOptions();
		const response = await startAuthentication({ optionsJSON });
		account = (await api.loginVerify(response)).account;
	}

	async function logout() {
		account = (await api.logout()).account;
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
		account = (await api.status()).account;
	}

	onMount(() => {
		supported = browserSupportsWebAuthn();
		void run(restore);
	});
</script>

<section
	class="account"
	class:authenticated={!!account}
	aria-label="送信者のログイン"
>
	{#if account}
		<p role="status">{account.name} としてログイン中</p>
		<button
			disabled={pending}
			onclick={() => run(logout)}>ログアウト</button
		>
	{:else}
		<h2>写真を送る準備をしましょう</h2>
		<p>
			ログインまたは新規登録すると、送る写真を選べます。受け取る人の登録は不要です。
		</p>
		<h3>アカウントをお持ちの方</h3>
		<button
			class="login"
			disabled={pending || !supported}
			onclick={() => run(login)}>パスキーでログイン</button
		>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void run(register);
			}}
		>
			<h3>初めての方は新規登録</h3>
			<label
				>初めての方はユーザーIDを入力<input
					bind:value={name}
					required
					maxlength="40"
					autocomplete="username"
					placeholder="ユーザーID"
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
		margin: 0;
		padding: 0;
		color: #283f35;
	}
	.account.authenticated {
		border-bottom: 1px solid #dedcd1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding-bottom: 20px;
		margin-bottom: 24px;
	}
	h2 {
		font-size: 18px;
		line-height: 1.5;
		margin: 0;
	}
	h3 {
		font-size: 13px;
		font-weight: 600;
		margin: 24px 0 12px;
	}
	form h3 {
		margin: 0;
	}
	p {
		font-size: 13px;
		line-height: 1.8;
		color: #6c7064;
		overflow-wrap: anywhere;
	}
	form,
	label {
		display: grid;
		gap: 12px;
		min-width: 0;
	}
	label {
		font-size: 13px;
		color: #555f53;
	}
	form {
		margin-top: 24px;
		padding-top: 24px;
		border-top: 1px solid #dedcd1;
	}
	button,
	input {
		font: inherit;
		font-size: 13px;
		min-height: 44px;
		padding: 12px 16px;
		border: 1px solid #cdcbbc;
		border-radius: 6px;
	}
	input {
		width: 100%;
		min-width: 0;
		background: #fff;
		color: #283f35;
	}
	button {
		cursor: pointer;
		background: #fff;
		color: #a23d24;
		font-weight: 600;
	}
	button:not(:disabled):hover {
		background: #f6f0e5;
	}
	.login {
		width: 100%;
		background: #b64629;
		border-color: #b64629;
		color: #fff;
	}
	.login:not(:disabled):hover {
		background: #963820;
	}
	.authenticated button {
		flex-shrink: 0;
		border: 0;
		font-weight: 400;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	input:focus-visible {
		outline: 3px solid #b64629;
		outline-offset: 4px;
	}
	.hint {
		font-size: 12px;
		margin: 16px 0 0;
	}
	[role='alert'] {
		color: #b42318;
		background: #fff0ef;
		padding: 12px;
		border-radius: 6px;
	}
</style>
