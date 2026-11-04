import { expect, test } from 'vitest';
import { checkGroupSlot, replaceGroupMember, decideGroupMember, recordGroupOutcome } from './groups.ts';
import type { GroupParticipant } from '../../../shared/protocol.ts';

const transfer = { id: 'transfer', to: { id: 'receiver', name: 'Receiver' } };

const member = (): GroupParticipant => replaceGroupMember([], transfer)[0];

test.each(['approve', 'accept'])('both decisions are required regardless of whether %s arrives first', (first) => {
	const original = [member()];
	const waiting = decideGroupMember(original, transfer.id, first);
	expect(waiting[0].status).toBe('waiting');
	const queued = decideGroupMember(waiting, transfer.id, first === 'approve' ? 'accept' : 'approve');
	expect(queued[0]).toMatchObject({ status: 'queued', approved: true, accepted: true });
	expect(original[0]).toMatchObject({ status: 'waiting', approved: false, accepted: false });
});

test('a failed retry replaces the transfer, preserves other members and requires new decisions', () => {
	const previous = { ...member(), status: 'failed' as const, approved: true, accepted: true };
	const other = { ...member(), id: 'other', device: { id: 'other', name: 'Other' } };
	const participants = [other, previous];
	checkGroupSlot(participants, transfer.to.id);
	const next = replaceGroupMember(participants, { ...transfer, id: 'retry' });
	expect(next).toEqual([other, { ...member(), id: 'retry', attempts: 2 }]);
	expect(previous.status).toBe('failed');
});

test('a full group permits a failed member to retry but rejects a new session', () => {
	const participants = Array.from({ length: 5 }, (_, id) => ({ ...member(), device: { id: String(id), name: 'Guest' } }));
	participants[0].status = 'failed';
	expect(() => checkGroupSlot(participants, '0')).not.toThrow();
	expect(() => checkGroupSlot(participants, 'new')).toThrow('5人まで');
	participants[0].attempts = 3;
	expect(() => checkGroupSlot(participants, '0')).toThrow('再参加できません');
});

test.each(['waiting', 'queued', 'transferring', 'complete', 'declined'] as const)('a %s member cannot retry', (status) => {
	expect(() => checkGroupSlot([{ ...member(), status }], transfer.to.id)).toThrow('再参加できません');
});

test.each([
	['complete', 'complete'],
	['rejected', 'declined'],
	['cancelled', 'declined'],
	['failed', 'failed'],
	['disconnected', 'failed'],
	['timeout', 'failed']
] as const)('%s records %s without changing the original participants', (reason, status) => {
	const participants = [member()];
	expect(recordGroupOutcome(participants, transfer.id, reason)[0].status).toBe(status);
	expect(participants[0].status).toBe('waiting');
});
