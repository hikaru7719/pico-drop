import { test, expect, vi } from 'vitest';
import { expireRecords, scheduleExpiry } from './expiry.ts';
const now = Date.now();

function storage(alarm: number | null = null) {
	return {
		getAlarm: vi.fn(async () => alarm),
		setAlarm: vi.fn(),
		list: vi.fn(async () => records()),
		delete: vi.fn()
	};
}

test.each([null, now + 60000])('schedules near-term expiry when alarm is %s', async (alarm) => {
	const store = storage(alarm);
	await scheduleExpiry(store as never);
	expect(store.setAlarm).toHaveBeenCalledWith(expect.any(Number));
});
test('preserves an earlier alarm', async () => {
	const store = storage(now + 1000);
	await scheduleExpiry(store as never);
	expect(store.setAlarm).not.toHaveBeenCalled();
});
test('expiry deletes expired records and retains accounts and future records', async () => {
	const store = storage();
	await expireRecords(store as never);
	expect(store.delete).toHaveBeenCalledExactlyOnceWith('expired');
	expect(store.setAlarm).toHaveBeenCalled();
});

function records() {
	return new Map([
		['expired', { expiresAt: 0 }],
		['future', { expiresAt: now + 60000 }],
		['account', {}]
	]);
}
