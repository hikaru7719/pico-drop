import { LIMITS, type GroupParticipant, type TransferState, type ServerMessage } from '../../../shared/protocol.ts';

type GroupTransfer = Pick<TransferState, 'id' | 'to'>;

type EndReason = Extract<ServerMessage, { type: 'ended' }>['reason'];

export function checkGroupSlot(participants: GroupParticipant[], deviceId: string) {
	const previous = participants.find((p) => p.device.id === deviceId);
	if (!previous && participants.length >= LIMITS.participants) {
		throw new Error('この配布は5人までです。送信者に新しい配布をお願いしてください。');
	}
	checkGroupRetry(previous);
}

function checkGroupRetry(previous?: GroupParticipant) {
	if (previous && (previous.status !== 'failed' || previous.attempts >= LIMITS.groupAttempts)) {
		throw new Error('再参加できません。再送は失敗した場合に2回までです。');
	}
}

export function replaceGroupMember(participants: GroupParticipant[], transfer: GroupTransfer) {
	const previous = participants.find((p) => p.device.id === transfer.to.id);
	const member = groupMember(transfer, (previous?.attempts ?? 0) + 1);
	return [...participants.filter((p) => p !== previous), member];
}

function groupMember(transfer: GroupTransfer, attempts: number): GroupParticipant {
	return {
		id: transfer.id,
		device: transfer.to,
		status: 'waiting',
		approved: false,
		accepted: false,
		attempts
	};
}

export function decideGroupMember(participants: GroupParticipant[], id: string, action: string) {
	return participants.map((member) => (member.id === id ? decide(member, action) : member));
}

function decide(member: GroupParticipant, action: string): GroupParticipant {
	const approved = member.approved || action === 'approve';
	const accepted = member.accepted || action !== 'approve';
	return { ...member, approved, accepted, status: approved && accepted ? 'queued' : 'waiting' };
}

export function recordGroupOutcome(participants: GroupParticipant[], id: string, reason: EndReason) {
	return participants.map((member) => (member.id === id ? { ...member, status: outcome(reason) } : member));
}

function outcome(reason: EndReason): GroupParticipant['status'] {
	if (reason === 'complete') {
		return 'complete';
	}
	return ['rejected', 'cancelled'].includes(reason) ? 'declined' : 'failed';
}
