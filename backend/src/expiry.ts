type Expiring = { expiresAt?: number };
export async function scheduleExpiry(storage: DurableObjectStorage) {
	const current = await storage.getAlarm();
	const next = Date.now() + 15_000;
	if (current === null || current > next) {
		await storage.setAlarm(next);
	}
}
async function reschedule(storage: DurableObjectStorage) {
	const entries = await storage.list<Expiring>();
	const next = firstExpiry(entries.values());
	if (Number.isFinite(next)) {
		await storage.setAlarm(Math.max(Date.now() + 15_000, next));
	}
}
export async function expireRecords(storage: DurableObjectStorage) {
	const entries = await storage.list<Expiring>();
	for (const [key, value] of entries) {
		if (value.expiresAt !== undefined && value.expiresAt <= Date.now()) {
			await storage.delete(key);
		}
	}
	await reschedule(storage);
}

function firstExpiry(values: Iterable<Expiring>) {
	let next = Infinity;
	for (const value of values) {
		if (value.expiresAt !== undefined) {
			next = Math.min(next, value.expiresAt);
		}
	}
	return next;
}
