import { afterEach, expect, test, vi } from 'vitest';
import { Invitations } from './invitations.svelte.ts';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function fixture() {
	const callbacks = { join: vi.fn(), expired: vi.fn(), notice: vi.fn(), error: vi.fn() };
	vi.stubGlobal('window', { location: { origin: 'https://example.com', hash: '' } });
	return { invitation: new Invitations(callbacks), callbacks };
}

test('resetting one invitation leaves another invitation expiry active', () => {
	vi.useFakeTimers();
	const [first, second] = [fixture(), fixture()];
	first.invitation.created('a'.repeat(64), Date.now() + 1000);
	second.invitation.created('b'.repeat(64), Date.now() + 1000);
	first.invitation.reset();
	vi.advanceTimersByTime(1000);
	expect(first.callbacks.expired).not.toHaveBeenCalled();
	expect(second.callbacks.expired).toHaveBeenCalledOnce();
});

function readHash(invitation: Invitations, hash: string) {
	window.location.hash = hash;
	const listener = invitation.read;
	listener();
}

test('the detached hash listener joins valid invitations and clears invalid tokens', () => {
	const { invitation, callbacks } = fixture();
	readHash(invitation, '#share=' + 'a'.repeat(64));
	expect(invitation.token).toBe('a'.repeat(64));
	expect(callbacks.join).toHaveBeenCalledOnce();
	readHash(invitation, '#share=invalid');
	expect(invitation.token).toBe('');
	expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('正しくありません'));
});
