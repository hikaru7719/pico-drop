import { requestLoginKey } from './session-auth.ts';
import { identity, allowSend, routedToken } from './routing.ts';
import type { Bindings } from './bindings.ts';
import {
	createPhotoAccess,
	consumePhoto,
	revokePhoto
} from './photo-access.ts';
import {
	LIMITS,
	parseClient,
	authorizeTransfer,
	type GroupParticipant,
	type ClientMessage,
	type Device,
	type PhotoMeta,
	type ServerMessage,
	type Session,
	type TransferState
} from '../../shared/protocol.ts';
type Attachment = {
	connectedAt: number;
	authKey?: string;
	session?: Omit<Session, 'token'>;
	linkKey?: string;
	transfer?: string;
	window?: number;
	messages?: number;
	requests?: number;
	turnCount?: number;
};
const json = (data: unknown, status = 200) =>
	Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function hash(value: string) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
		),
		(x) => x.toString(16).padStart(2, '0')
	).join('');
}
function send(ws: WebSocket, message: ServerMessage) {
	try {
		ws.send(JSON.stringify(message));
	} catch {
		/* Close handler removes presence. */
	}
}

type LinkJoin = {
	ws: WebSocket;
	a: Attachment;
	key: string;
	link: ShareLink;
	owner: WebSocket;
};
type TransferSockets = {
	owner: WebSocket;
	ws: WebSocket;
	sender: Attachment;
	a: Attachment;
	t: TransferState;
};
function newLink(owner: string, files: PhotoMeta[]): ShareLink {
	return { owner, files, expiresAt: Date.now() + LIMITS.linkMs };
}

type StoredSession = Omit<Session, 'token'> & {
	used?: boolean;
	authKey?: string;
};
type Expiring = { expiresAt?: number };
type EndReason = Extract<ServerMessage, { type: 'ended' }>['reason'];
type TransferMessage = Extract<ClientMessage, { id: string }>;
type CreateLinkMessage = Extract<ClientMessage, { type: 'create-link' }>;
type GroupStart = {
	key: string;
	link: ShareLink;
	owner: WebSocket;
	member: GroupParticipant;
};
const REQUEST_LIMIT = '送信要求が多すぎます。1分後に再試行してください。';
const LINK_UNAVAILABLE =
	'この共有リンクは使えません。有効期限が切れたか、すでに使われたか、送信者が画面を閉じた可能性があります。送信者に新しいリンクを作ってもらってください。';
type ShareLink = {
	owner: string;
	files: PhotoMeta[];
	expiresAt: number;
	participants?: GroupParticipant[];
};
const TURN_LIMIT = '接続設定の取得上限です。再接続してください。';
const TURN_FAILED = '中継サーバーの準備に失敗しました。再試行してください。';
const device = (session: Device): Device => ({
	id: session.id,
	name: session.name
});
function randomToken() {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
		x.toString(16).padStart(2, '0')
	).join('');
}
function newSession(): Session {
	const id = crypto.randomUUID();
	return {
		id,
		token: randomToken(),
		name: `ゲスト ${id.slice(0, 4).toUpperCase()}`,
		expiresAt: Date.now() + LIMITS.sessionMs
	};
}

function turnHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		'Content-Type': 'application/json'
	};
}
function turnRequest(token: string): RequestInit {
	return {
		method: 'POST',
		headers: turnHeaders(token),
		body: JSON.stringify({ ttl: 900 }),
		signal: AbortSignal.timeout(10_000)
	};
}

async function turnServers(env: Bindings) {
	const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID!)}/credentials/generate-ice-servers`;
	const response = await fetch(url, turnRequest(env.TURN_KEY_API_TOKEN!));
	if (!response.ok) {
		throw new Error('TURN');
	}
	const data = (await response.json()) as { iceServers: unknown[] };
	return json({ iceServers: data.iceServers, relay: true });
}
function sessionExpired(a: Attachment, now: number) {
	return (
		(!a.session && a.connectedAt < now - 10_000) ||
		(a.session && a.session.expiresAt <= now)
	);
}
export class RoomHub {
	constructor(
		private ctx: DurableObjectState,
		private env: Bindings
	) {}
	async consumePhoto(token: string, id: string, mode: string) {
		return this.ctx.blockConcurrencyWhile(() =>
			consumePhoto(this.ctx.storage, { token, id, mode })
		);
	}
	async revokePhoto(token: string) {
		await this.ctx.blockConcurrencyWhile(() =>
			revokePhoto(this.ctx.storage, token)
		);
	}
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const upgrade =
			request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
		if (path === '/api/ws' && upgrade) {
			return this.upgradeSocket();
		}
		return this.post(request, path);
	}
	async post(request: Request, path: string) {
		if (request.method !== 'POST') {
			return json({ error: 'Method not allowed' }, 405);
		}
		return this.postRoute(request, path);
	}
	async postRoute(request: Request, path: string) {
		if (path === '/api/session') {
			return this.ctx.blockConcurrencyWhile(() => this.createSession(request));
		}
		return path === '/api/ice'
			? this.ice(request)
			: json({ error: 'Method not allowed' }, 405);
	}
	async upgradeSocket() {
		if (this.ctx.getWebSockets().length >= 200) {
			return json({ error: '混み合っています。後でお試しください。' }, 503);
		}
		return this.acceptSocket();
	}
	async acceptSocket() {
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment({
			connectedAt: Date.now()
		} satisfies Attachment);
		await this.schedule();
		return new Response(null, { status: 101, webSocket: pair[0] });
	}
	async createSession(request: Request) {
		const room = new URL(request.url).searchParams.get('room') ?? undefined;
		await this.ctx.storage.put('routing:room', room ?? '');
		const session = { ...newSession(), token: routedToken(room), room };
		return this.storeSession(request, session);
	}
	async storeSession(request: Request, session: Session) {
		const stored = await this.sessionIdentity(request, session);
		await this.ctx.storage.put(
			'session:' + (await hash(session.token)),
			stored
		);
		await this.schedule();
		return json(session, 201);
	}
	async sessionAccount(key: string) {
		return identity(this.env, key);
	}
	async sessionIdentity(request: Request, session: Session) {
		const authKey = await requestLoginKey(request);
		const account = await this.sessionAccount(authKey);
		if (account) {
			session.name = account.name;
		}
		const { token: _token, ...stored } = session;
		return { ...stored, authKey: account ? authKey : undefined };
	}
	async iceSocket(request: Request) {
		const token =
			request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
		if (!/^[a-f0-9]{64}$/.test(token)) {
			return undefined;
		}
		return this.sessionSocket(token);
	}
	async sessionSocket(token: string) {
		const session = await this.ctx.storage.get<StoredSession>(
			'session:' + (await hash(token))
		);
		return session && session.expiresAt > Date.now()
			? this.socket(session.id)
			: undefined;
	}
	async activeTransfer(ws: WebSocket) {
		const a = this.attachment(ws);
		const t =
			a.transfer &&
			(await this.ctx.storage.get<TransferState>('transfer:' + a.transfer));
		return t && t.started && t.expiresAt > Date.now();
	}
	async ice(request: Request) {
		const ws = await this.iceSocket(request);
		if (!ws) {
			return json({ error: 'Unauthorized' }, 401);
		}
		if (!(await this.activeTransfer(ws))) {
			return json({ error: '転送の確認が必要です。' }, 403);
		}
		return this.issueIce(ws);
	}
	async issueIce(ws: WebSocket) {
		const latest = this.attachment(ws);
		if ((latest.turnCount ?? 0) >= this.turnLimit(latest)) {
			return json({ error: TURN_LIMIT }, 429);
		}
		latest.turnCount = (latest.turnCount ?? 0) + 1;
		ws.serializeAttachment(latest);
		return this.iceServers();
	}
	turnLimit(a: Attachment) {
		return a.linkKey ? LIMITS.participants * LIMITS.groupAttempts : 10;
	}
	async iceServers() {
		if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN) {
			return json({
				iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
				relay: false
			});
		}
		return this.turnServers();
	}
	async turnServers() {
		try {
			return await turnServers(this.env);
		} catch {
			return json({ error: TURN_FAILED }, 503);
		}
	}
	attachment(ws: WebSocket): Attachment {
		return ws.deserializeAttachment() as Attachment;
	}
	socket(id: string) {
		return this.ctx
			.getWebSockets()
			.find(
				(ws) =>
					this.attachment(ws).session?.id === id &&
					ws.readyState === WebSocket.OPEN
			);
	}
	async schedule() {
		const alarm = await this.ctx.storage.getAlarm();
		const next = Date.now() + 15_000;
		if (alarm === null || alarm > next) {
			await this.ctx.storage.setAlarm(next);
		}
	}
	clearTransfer(ws: WebSocket, id: string) {
		const a = this.attachment(ws);
		if (a.transfer === id) {
			delete a.transfer;
			ws.serializeAttachment(a);
		}
	}
	notifyEnd(
		participant: Device,
		message: Extract<ServerMessage, { type: 'ended' }>
	) {
		const ws = this.socket(participant.id);
		if (ws) {
			this.clearTransfer(ws, message.id);
			send(ws, message);
		}
	}
	async end(id: string, reason: EndReason) {
		const transfer = await this.ctx.storage.get<TransferState>(
			'transfer:' + id
		);
		if (transfer) {
			await this.finishTransfer(transfer, reason);
		}
	}
	async finishTransfer(t: TransferState, reason: EndReason) {
		const photoAccess =
			reason === 'complete' ? await this.photoAccess(t.files) : undefined;
		await this.ctx.storage.delete('transfer:' + t.id);
		this.notifyEnd(t.from, { type: 'ended', id: t.id, reason });
		this.notifyEnd(t.to, { type: 'ended', id: t.id, reason, photoAccess });
		await this.finishGroupMember(t, reason);
	}
	async photoAccess(files: PhotoMeta[]) {
		const room = await this.ctx.storage.get<string>('routing:room');
		return createPhotoAccess(this.ctx.storage, files, room);
	}
	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		await this.ctx.blockConcurrencyWhile(() => this.receive(ws, raw));
	}
	async receive(ws: WebSocket, raw: string | ArrayBuffer) {
		try {
			await this.handleRaw(ws, raw);
		} catch (e) {
			send(ws, {
				type: 'error',
				message: e instanceof Error ? e.message : '処理に失敗しました。'
			});
		}
	}
	messageRate(ws: WebSocket) {
		const a = this.attachment(ws);
		if (!a.window || a.window < Date.now() - 60_000) {
			Object.assign(a, { window: Date.now(), messages: 0, requests: 0 });
		}
		a.messages = (a.messages ?? 0) + 1;
		ws.serializeAttachment(a);
		return a;
	}
	async handleRaw(ws: WebSocket, raw: string | ArrayBuffer) {
		const text = controlMessage(raw);
		const a = this.messageRate(ws);
		if (this.closeOverLimit(ws, a)) {
			return;
		}
		await this.handleMessage(ws, a, parseClient(JSON.parse(text)));
	}
	closeOverLimit(ws: WebSocket, a: Attachment) {
		if (a.messages! <= 240) {
			return false;
		}
		ws.close(1008, 'Rate limit');
		return true;
	}
	async handleMessage(ws: WebSocket, a: Attachment, m: ClientMessage) {
		if (m.type === 'auth' && !a.session) {
			return this.authenticate(ws, a, m.token);
		}
		if (!a.session || a.session.expiresAt <= Date.now()) {
			ws.close(1008, 'Session expired');
		} else {
			await this.authenticatedMessage(ws, a, m);
		}
	}
	async authenticatedMessage(ws: WebSocket, a: Attachment, m: ClientMessage) {
		if (m.type === 'create-link') {
			return this.createLink(ws, a, m);
		}
		if (m.type === 'join-link') {
			return this.joinLink(ws, a, m.token);
		}
		await this.otherMessage(ws, a, m);
	}
	async otherMessage(ws: WebSocket, a: Attachment, m: ClientMessage) {
		if (m.type === 'revoke-link') {
			return this.revokeLink(ws, a);
		}
		await this.checkedTransferAction(a, m);
	}
	async checkedTransferAction(a: Attachment, m: ClientMessage) {
		if (!('id' in m) || !(await this.controlsTransfer(a, m.id))) {
			throw new Error('転送が見つかりません。');
		}
		await this.transferAction(a, m);
	}
	async controlsTransfer(a: Attachment, id: string) {
		if (a.transfer === id) {
			return true;
		}
		const t = await this.ctx.storage.get<TransferState>('transfer:' + id);
		return (
			!!t?.groupKey && t.groupKey === a.linkKey && t.from.id === a.session?.id
		);
	}
	invalidSession(session: StoredSession | undefined) {
		return (
			!session ||
			session.used ||
			session.expiresAt <= Date.now() ||
			this.socket(session.id)
		);
	}
	async authenticate(ws: WebSocket, a: Attachment, token: string) {
		const key = 'session:' + (await hash(token));
		const session = await this.ctx.storage.get<StoredSession>(key);
		if (this.invalidSession(session)) {
			ws.close(1008, 'Invalid session');
		} else {
			await this.acceptSession(ws, a, { key, session: session! });
		}
	}
	async acceptSession(ws: WebSocket, a: Attachment, stored: StoredIdentity) {
		const { key, session } = stored;
		await this.ctx.storage.put(key, { ...session, used: true });
		a.session = { ...device(session), expiresAt: session.expiresAt };
		a.authKey = session.authKey;
		ws.serializeAttachment(a);
		send(ws, { type: 'ready', device: device(session) });
	}
	checkRequestRate(ws: WebSocket, a: Attachment) {
		a.requests = (a.requests ?? 0) + 1;
		ws.serializeAttachment(a);
		if (a.requests > 5) {
			throw new Error(REQUEST_LIMIT);
		}
	}
	newTransfer(a: Attachment, b: Attachment, files: PhotoMeta[]): TransferState {
		return {
			id: crypto.randomUUID(),
			from: device(a.session!),
			to: device(b.session!),
			files,
			started: false,
			expiresAt: Date.now() + LIMITS.requestMs
		};
	}
	async revokeLink(ws: WebSocket, a: Attachment) {
		if (a.linkKey) {
			const key = a.linkKey;
			delete a.linkKey;
			ws.serializeAttachment(a);
			await this.stopGroup(key);
			send(ws, { type: 'link-ended' });
		}
	}
	async createLink(ws: WebSocket, a: Attachment, message: CreateLinkMessage) {
		await allowSend(this.env, a.authKey ?? '');
		this.checkRequestRate(ws, a);
		this.checkLinkParticipant(a);
		await this.revokeLink(ws, a);
		return this.issueLink(ws, a, message);
	}
	async issueLink(ws: WebSocket, a: Attachment, message: CreateLinkMessage) {
		const token = routedToken(
			await this.ctx.storage.get<string>('routing:room')
		);
		const link = this.linkDetails(a, message);
		a.linkKey = 'link:' + (await hash(token));
		await this.storeLink(ws, a, link);
		send(ws, { type: 'link-created', token, expiresAt: link.expiresAt });
	}
	linkDetails(a: Attachment, message: CreateLinkMessage) {
		const link = newLink(a.session!.id, message.files);
		if (message.mode === 'group') {
			link.participants = [];
		}
		return link;
	}
	async storeLink(ws: WebSocket, a: Attachment, link: ShareLink) {
		await this.ctx.storage.put(a.linkKey!, link);
		ws.serializeAttachment(a);
		await this.schedule();
	}
	checkLinkParticipant(a: Attachment) {
		if (a.transfer) {
			throw new Error('転送中です。完了後にお試しください。');
		}
	}
	async joinLink(ws: WebSocket, a: Attachment, token: string) {
		this.checkRequestRate(ws, a);
		this.checkLinkParticipant(a);
		const key = 'link:' + (await hash(token));
		const link = await this.ctx.storage.get<ShareLink>(key);
		const owner = this.linkOwner(ws, link);
		await this.joinSharedLink({ ws, a, key, link: link!, owner });
	}
	async joinSharedLink(context: LinkJoin) {
		return context.link.participants
			? this.joinGroup(context)
			: this.consumeLink(context);
	}
	linkOwner(ws: WebSocket, link: ShareLink | undefined) {
		const owner = link && this.socket(link.owner);
		if (!link || link.expiresAt <= Date.now() || !owner || owner === ws) {
			throw new Error(LINK_UNAVAILABLE);
		}
		return owner;
	}
	async consumeLink(context: LinkJoin) {
		const { ws, a, key, link, owner } = context;
		const sender = this.attachment(owner);
		this.checkLinkParticipant(sender);
		await this.ctx.storage.delete(key);
		delete sender.linkKey;
		await this.revokeLink(ws, a);
		const t = this.newTransfer(sender, a, link.files);
		await this.storeTransfer({ owner, ws, sender, a, t });
	}
	async storeTransfer(context: TransferSockets) {
		const { owner, ws, sender, a, t } = context;
		await this.ctx.storage.put('transfer:' + t.id, t);
		this.attachTransfer(owner, sender, t);
		this.attachTransfer(ws, a, t);
	}
	attachTransfer(ws: WebSocket, a: Attachment, t: TransferState) {
		a.transfer = t.id;
		ws.serializeAttachment(a);
		send(ws, requestedMessage(t));
	}
	async joinGroup(context: LinkJoin) {
		const { ws, a, key, link, owner } = context;
		this.checkGroupSlot(link, a.session!.id);
		await this.revokeLink(ws, a);
		const t = this.newTransfer(this.attachment(owner), a, link.files);
		t.groupKey = key;
		t.expiresAt = link.expiresAt;
		await this.storeGroupMember(context, t);
	}
	checkGroupSlot(link: ShareLink, deviceId: string) {
		const previous = link.participants!.find((p) => p.device.id === deviceId);
		if (!previous && link.participants!.length >= LIMITS.participants) {
			throw new Error(
				'この配布は5人までです。送信者に新しい配布をお願いしてください。'
			);
		}
		this.checkGroupRetry(previous);
	}
	checkGroupRetry(previous?: GroupParticipant) {
		if (
			previous &&
			(previous.status !== 'failed' ||
				previous.attempts >= LIMITS.groupAttempts)
		) {
			throw new Error('再参加できません。再送は失敗した場合に2回までです。');
		}
	}
	async storeGroupMember(context: LinkJoin, t: TransferState) {
		const { ws, a, key, link } = context;
		this.replaceGroupMember(link, t);
		await this.ctx.storage.put('transfer:' + t.id, t);
		await this.publishGroup(key, link);
		this.attachTransfer(ws, a, t);
	}
	replaceGroupMember(link: ShareLink, t: TransferState) {
		const previous = link.participants!.find((p) => p.device.id === t.to.id);
		const member = this.groupMember(t, (previous?.attempts ?? 0) + 1);
		link.participants = [
			...link.participants!.filter((p) => p !== previous),
			member
		];
	}
	groupMember(t: TransferState, attempts: number): GroupParticipant {
		return {
			id: t.id,
			device: t.to,
			status: 'waiting',
			approved: false,
			accepted: false,
			attempts
		};
	}
	async publishGroup(key: string, link: ShareLink) {
		await this.ctx.storage.put(key, link);
		const owner = this.socket(link.owner);
		if (owner) {
			send(owner, { type: 'group-state', participants: link.participants! });
		}
	}
	async groupDecision(t: TransferState, action: string) {
		const link = await this.ctx.storage.get<ShareLink>(t.groupKey!);
		if (!link || link.expiresAt <= Date.now()) {
			throw new Error(LINK_UNAVAILABLE);
		}
		this.updateGroupDecision(link, t.id, action);
		await this.publishGroup(t.groupKey!, link);
		await this.advanceGroup(t.groupKey!);
	}
	updateGroupDecision(link: ShareLink, id: string, action: string) {
		const member = link.participants!.find((p) => p.id === id)!;
		if (action === 'approve') {
			member.approved = true;
		} else {
			member.accepted = true;
		}
		member.status = member.approved && member.accepted ? 'queued' : 'waiting';
	}
	async advanceGroup(key: string) {
		const link = await this.ctx.storage.get<ShareLink>(key);
		const owner = link && this.socket(link.owner);
		if (!link || !owner || !this.groupCanStart(link, owner)) {
			return;
		}
		const member = link.participants!.find((p) => p.status === 'queued');
		await this.startNextGroupMember(key, link, owner, member);
	}
	async startNextGroupMember(
		key: string,
		link: ShareLink,
		owner: WebSocket,
		member?: GroupParticipant
	) {
		if (member) {
			await this.startGroupMember({ key, link, owner, member });
		}
	}
	groupCanStart(link: ShareLink, owner: WebSocket) {
		return link.expiresAt > Date.now() && !this.attachment(owner).transfer;
	}
	async startGroupMember(context: GroupStart) {
		const { member } = context;
		const t = await this.ctx.storage.get<TransferState>(
			'transfer:' + member.id
		);
		if (!t || !this.socket(t.to.id)) {
			return this.end(member.id, 'disconnected');
		}
		await this.activateGroupTransfer(context, t);
	}
	async activateGroupTransfer(context: GroupStart, t: TransferState) {
		const { key, link, owner, member } = context;
		member.status = 'transferring';
		await this.publishGroup(key, link);
		this.attachTransfer(owner, this.attachment(owner), t);
		await this.acceptTransfer(t);
	}
	async finishGroupMember(t: TransferState, reason: EndReason) {
		if (!t.groupKey) {
			return;
		}
		const link = await this.ctx.storage.get<ShareLink>(t.groupKey);
		if (!link?.participants) {
			return;
		}
		await this.updateGroupOutcome(link, t, reason);
	}
	async updateGroupOutcome(
		link: ShareLink,
		t: TransferState,
		reason: EndReason
	) {
		this.setGroupOutcome(link, t.id, reason);
		await this.publishGroup(t.groupKey!, link);
		await this.advanceGroup(t.groupKey!);
	}
	setGroupOutcome(link: ShareLink, id: string, reason: EndReason) {
		const member = link.participants!.find((p) => p.id === id);
		if (member) {
			member.status = this.groupOutcome(reason);
		}
	}
	groupOutcome(reason: EndReason): GroupParticipant['status'] {
		if (reason === 'complete') {
			return 'complete';
		}
		return ['rejected', 'cancelled'].includes(reason) ? 'declined' : 'failed';
	}
	async stopGroup(key: string) {
		const link = await this.ctx.storage.get<ShareLink>(key);
		await this.ctx.storage.delete(key);
		for (const member of link?.participants ?? []) {
			await this.end(member.id, 'cancelled');
		}
	}
	async transferAction(a: Attachment, m: TransferMessage) {
		const t = await this.ctx.storage.get<TransferState>('transfer:' + m.id);
		if (!t) {
			throw new Error('転送が期限切れです。');
		}
		authorizeTransfer(t, a.session!.id, m.type);
		await this.applyTransferAction(a.session!.id, t, m);
	}
	async applyTransferAction(
		actor: string,
		t: TransferState,
		m: TransferMessage
	) {
		if (m.type === 'signal') {
			return this.relaySignal(actor, t, m);
		}
		await this.applyTransferDecision(t, m.type);
	}
	async applyTransferDecision(t: TransferState, type: string) {
		if (t.groupKey && ['accept', 'approve'].includes(type)) {
			return this.groupDecision(t, type);
		}
		if (type === 'accept') {
			await this.acceptTransfer(t);
		} else {
			await this.end(t.id, endReason(type));
		}
	}
	relaySignal(
		actor: string,
		t: TransferState,
		m: Extract<ClientMessage, { type: 'signal' }>
	) {
		const other = this.socket(actor === t.from.id ? t.to.id : t.from.id);
		if (other) {
			send(other, { type: 'signal', id: t.id, signal: m.signal });
		}
	}
	async acceptTransfer(t: TransferState) {
		t.started = true;
		t.expiresAt = t.groupKey ? t.expiresAt : Date.now() + LIMITS.transferMs;
		await this.ctx.storage.put('transfer:' + t.id, t);
		for (const participant of [t.from, t.to]) {
			this.notifyStart(participant.id, t.id);
		}
	}
	notifyStart(participant: string, id: string) {
		const ws = this.socket(participant);
		if (ws) {
			send(ws, { type: 'start', id });
		}
	}
	async webSocketClose(ws: WebSocket) {
		await this.ctx.blockConcurrencyWhile(() => this.closeSocket(ws));
	}
	async closeSocket(ws: WebSocket) {
		const a = this.attachment(ws);
		await this.revokeLink(ws, a);
		if (a.transfer) {
			await this.end(a.transfer, 'disconnected');
		}
		ws.close();
	}
	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}
	async alarm() {
		await this.ctx.blockConcurrencyWhile(() => this.expire());
	}
	async expireSocket(ws: WebSocket, now: number) {
		const a = this.attachment(ws);
		if (sessionExpired(a, now)) {
			await this.closeExpired(ws, a);
		}
	}
	async closeExpired(ws: WebSocket, a: Attachment) {
		await this.revokeLink(ws, a);
		if (a.transfer) {
			await this.end(a.transfer, 'timeout');
		}
		ws.close(1008, 'Session expired');
	}
	async expireEntry(key: string, expiresAt: number, now: number) {
		if (!(expiresAt <= now)) {
			return;
		}
		if (key.startsWith('transfer:')) {
			await this.end(key.slice(9), 'timeout');
		} else {
			await this.expireStoredEntry(key);
		}
	}
	async expireStoredEntry(key: string) {
		await this.expireLink(key);
		await this.ctx.storage.delete(key);
	}
	async expireLink(key: string) {
		for (const ws of this.ctx.getWebSockets()) {
			const a = this.attachment(ws);
			if (a.linkKey === key) {
				await this.revokeLink(ws, a);
			}
		}
	}
	async reschedule(now: number) {
		const next = await this.nextAlarm(now);
		if (Number.isFinite(next)) {
			await this.ctx.storage.setAlarm(next);
		}
	}
	async nextAlarm(now: number) {
		if (this.ctx.getWebSockets().length) {
			return now + 15_000;
		}
		const entries = await this.ctx.storage.list<Expiring>();
		return Math.max(now + 15_000, firstExpiry(entries.values()));
	}
	async expire() {
		const now = Date.now();
		for (const ws of this.ctx.getWebSockets()) {
			await this.expireSocket(ws, now);
		}
		await this.expireEntries(now);
		await this.reschedule(now);
	}
	async expireEntries(now: number) {
		const entries = await this.ctx.storage.list<{ expiresAt: number }>();
		for (const [key, value] of entries) {
			await this.expireEntry(key, value.expiresAt, now);
		}
	}
}

function controlMessage(raw: string | ArrayBuffer) {
	if (typeof raw !== 'string' || raw.length > 24_000) {
		throw new Error('制御メッセージのみ送信できます。');
	}
	return raw;
}
function requestedMessage(t: TransferState): ServerMessage {
	return {
		type: 'requested',
		...(t.groupKey ? { group: true, expiresAt: t.expiresAt } : {}),
		id: t.id,
		from: t.from,
		to: t.to,
		files: t.files
	};
}
function endReason(type: string): EndReason {
	if (type === 'fail') {
		return 'failed';
	}
	return type === 'reject'
		? 'rejected'
		: type === 'complete'
			? 'complete'
			: 'cancelled';
}

type StoredIdentity = { key: string; session: StoredSession };

function firstExpiry(entries: Iterable<Expiring>) {
	let next = Infinity;
	for (const entry of entries) {
		if (typeof entry.expiresAt === 'number') {
			next = Math.min(next, entry.expiresAt);
		}
	}
	return next;
}
