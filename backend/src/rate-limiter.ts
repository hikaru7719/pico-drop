import { expireRecords } from './expiry.ts';
type Rate = { count: number; expiresAt: number };
export class RateLimiter {
	constructor(private ctx: DurableObjectState) {}
	async limitRequest(kind: string) {
		return this.ctx.blockConcurrencyWhile(() => this.applyRequestLimit(kind));
	}
	async applyRequestLimit(kind: string) {
		const key = 'rate:' + kind;
		const rate = requestWindow(await this.ctx.storage.get<Rate>(key), kind);
		if (++rate.count > (kind === 'auth' ? 30 : 20)) {
			return false;
		}
		await this.ctx.storage.put(key, rate);
		await this.ctx.storage.setAlarm(rate.expiresAt);
		return true;
	}
	async alarm() {
		await expireRecords(this.ctx.storage);
	}
}
function requestWindow(old: Rate | undefined, kind: string): Rate {
	const duration = kind === 'auth' ? 600_000 : 60_000;
	return old && old.expiresAt > Date.now()
		? old
		: { count: 0, expiresAt: Date.now() + duration };
}
