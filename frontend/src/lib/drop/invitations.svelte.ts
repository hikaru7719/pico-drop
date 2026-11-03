type Callbacks = {
	join(): void;
	expired(): void;
	notice(message: string): void;
	error(message: string): void;
};

export class Invitations {
	token = $state('');
	used = $state(false);
	link = $state('');
	expiresAt = $state<number>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private callbacks: Callbacks) {}

	readonly read = () => {
		const token = new URLSearchParams(window.location.hash.slice(1)).get('share');
		this.token = '';
		if (token !== null) {
			this.apply(token);
		}
	};

	private apply(token: string) {
		if (/^[a-f0-9]{64}$/.test(token)) {
			this.used = false;
			this.token = token;
			this.callbacks.join();
		} else {
			this.callbacks.error('共有リンクが正しくありません。送信者に作り直してもらってください。');
		}
	}

	created(token: string, expiresAt: number) {
		clearTimeout(this.timer);
		this.link = `${window.location.origin}/#share=${token}`;
		this.expiresAt = expiresAt;
		this.timer = setTimeout(() => this.callbacks.expired(), Math.max(0, expiresAt - Date.now()));
	}

	reset() {
		clearTimeout(this.timer);
		this.link = '';
		this.expiresAt = undefined;
	}

	async share() {
		try {
			await this.publish();
		} catch (e) {
			if (!(e instanceof Error && e.name === 'AbortError')) {
				this.callbacks.error('共有できませんでした。リンクをコピーして送ってください。');
			}
		}
	}

	private async publish() {
		if (navigator.share) {
			await navigator.share({ title: 'Pico Drop', text: '写真の共有リンク（10分間有効）', url: this.link });
		} else {
			await this.copy();
		}
	}

	async copy() {
		try {
			await navigator.clipboard.writeText(this.link);
			this.callbacks.notice('リンクをコピーしました。LINEなどで相手に送ってください。');
		} catch {
			this.callbacks.error('コピーできませんでした。表示されたリンクを選択してコピーしてください。');
		}
	}
}
