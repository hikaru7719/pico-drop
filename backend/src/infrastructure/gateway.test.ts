import { test, expect, vi } from 'vitest';
import { gateway } from './gateway.ts';

test('room destinations use their own object IDs', () => {
	const get = vi.fn((name: string) => ({ name }));
	const env = { HUB: { idFromName: (name: string) => name, get } };
	expect(gateway(env as never).hub('room:a')).toEqual({ name: 'room:a' });
	expect(gateway(env as never).hub('room:b')).toEqual({ name: 'room:b' });
});
