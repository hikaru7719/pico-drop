import {
	clearPreviousChallenge,
	hubFor,
	authRoute,
	network,
	identity,
	allowSend,
	requestRate,
	roomRoute,
	routedToken,
	authShard
} from './routing.ts';
import type {
	WebAuthnCredential,
	AuthenticationResponseJSON
} from '@simplewebauthn/server';
import {
	PasskeyAuth,
	type Account,
	type Ceremony,
	type AuthEnv
} from './auth.ts';
import {
	createPhotoAccess,
	consumePhoto,
	revokePhoto
} from './photo-access.ts';
import { photoRequest } from './images.ts';
import { DurableObject } from 'cloudflare:workers';
import {
	LIMITS,
	parseClient,
	authorizeTransfer,
	type ClientMessage,
	type Device,
	type PhotoMeta,
	type ServerMessage,
	type Session,
	type TransferState
} from '../../shared/protocol.ts';

type Bindings = Env &
	AuthEnv & { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string };
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
type Rate = { count: number; expiresAt: number };
type Expiring = { expiresAt?: number };
type EndReason = Extract<ServerMessage, { type: 'ended' }>['reason'];
type TransferMessage = Extract<ClientMessage, { id: string }>;
const RATE_LIMIT = '認証の試行が多すぎます。しばらく待ってください。';
const SESSION_LIMIT = '接続回数が多すぎます。1分後に再試行してください。';
const REQUEST_LIMIT = '送信要求が多すぎます。1分後に再試行してください。';
const LINK_UNAVAILABLE =
	'この共有リンクは使えません。有効期限が切れたか、すでに使われたか、送信者が画面を閉じた可能性があります。送信者に新しいリンクを作ってもらってください。';
type ShareLink = { owner: string; files: PhotoMeta[]; expiresAt: number };
const TURN_LIMIT = '接続設定の取得上限です。再接続してください。';
const TURN_FAILED = '中継サーバーの準備に失敗しました。再試行してください。';
const device = (session: Device): Device => ({
	id: session.id,
	name: session.name
});
const API_PATHS = [
	'/api/session',
	'/api/ws',
	'/api/ice',
	'/api/photos/convert',
	'/api/photos/discard'
];
function requestError(request: Request, url: URL) {
	if (request.headers.get('Origin') !== url.origin) {
		return json({ error: 'Origin not allowed' }, 403);
	}
	return API_PATHS.includes(url.pathname) ||
		url.pathname.startsWith('/api/auth/')
		? null
		: json({ error: 'Not found' }, 404);
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api/health') {
			return json({ status: 'ok', service: 'pico-drop-backend' });
		}
		return requestError(request, url) ?? routeRequest(request, env);
	}
} satisfies ExportedHandler<Bindings>;

async function routeRequest(request: Request, env: Bindings) {
	const path = new URL(request.url).pathname;
	if (request.method !== 'POST' && path !== '/api/ws') {
		return json({ error: 'Method not allowed' }, 405);
	}
	return path.startsWith('/api/auth/')
		? routeAuth(request, env)
		: routeSession(request, env);
}
async function routeSession(request: Request, env: Bindings) {
	if (
		new URL(request.url).pathname === '/api/session' &&
		!(await requestRate(env, request, 'session'))
	) {
		return json({ error: SESSION_LIMIT }, 429);
	}
	return routeRoom(request, env);
}

async function routeAuth(request: Request, env: Bindings) {
	if (!(await allowedAuth(request, env))) {
		return json({ error: RATE_LIMIT }, 429);
	}
	await clearPreviousChallenge(env, request);
	const name = authRoute(request);
	const forwarded = new Request(request);
	forwarded.headers.set('X-Auth-Route', name);
	return hubFor(env, name).fetch(forwarded);
}
async function allowedAuth(request: Request, env: Bindings) {
	const path = new URL(request.url).pathname;
	return (
		path.endsWith('/status') ||
		path.endsWith('/logout') ||
		requestRate(env, request, 'auth')
	);
}
function routeRoom(request: Request, env: Bindings) {
	const room = roomRoute(request);
	if (!/^[a-f0-9]{16}$/.test(room)) {
		return json({ error: 'Invalid room' }, 400);
	}
	const hub = hubFor(env, 'room:' + room);
	return forwardRoom(request, env, { room, hub });
}
type RoomDestination = { room: string; hub: ReturnType<typeof hubFor> };
function forwardRoom(request: Request, env: Bindings, route: RoomDestination) {
	const url = new URL(request.url);
	url.searchParams.set('room', route.room);
	return url.pathname.startsWith('/api/photos/')
		? photoRequest(request, env.IMAGES, route.hub)
		: route.hub.fetch(new Request(url, request));
}

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
export class NearbyHub extends DurableObject<Bindings> {
	async accountIdentity(key: string) {
		return this.auth().identity(key);
	}
	async authorizeSend(key: string) {
		return this.ctx.blockConcurrencyWhile(() => this.auth().allowSend(key));
	}
	async revokeLogin(key: string) {
		if (key) {
			await this.ctx.storage.delete(key);
		}
	}
	async issueAccountLogin(account: Account) {
		const shard = authShard(account.id);
		const auth = this.auth(shard ? 'auth:' + shard : 'mvp');
		const token = auth.newToken();
		await auth.storeLogin(token, account.id);
		await this.schedule();
		return token;
	}
	async verifyAccountLogin(
		response: AuthenticationResponseJSON,
		origin: string,
		ceremony: Ceremony
	) {
		return this.ctx.blockConcurrencyWhile(() =>
			this.auth().completeLogin(response, new URL(origin), ceremony)
		);
	}
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
		if (path.startsWith('/api/auth/')) {
			return this.authRequest(request);
		}
		return this.postRoute(request, path);
	}
	async authRequest(request: Request) {
		const response = await this.auth(
			request.headers.get('X-Auth-Route') ?? 'mvp'
		).route(request);
		await this.schedule();
		return response;
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

	async sessionRate(request: Request) {
		const key =
			'rate:' +
			(await hash(request.headers.get('CF-Connecting-IP') ?? 'local'));
		const rate = await this.ctx.storage.get<Rate>(key);
		return { key, current: currentRate(rate) };
	}

	async checkSessionRate(request: Request) {
		const { key, current } = await this.sessionRate(request);
		if (++current.count > 20) {
			return false;
		}
		await this.ctx.storage.put(key, current);
		return true;
	}

	async createSession(request: Request) {
		if (!this.env?.HUB && !(await this.checkSessionRate(request))) {
			return json({ error: SESSION_LIMIT }, 429);
		}
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

	auth(name = 'mvp'): PasskeyAuth {
		const local = {
			take: (key: string) => this.consumeCeremony(key),
			register: (account: Account, credential: WebAuthnCredential) =>
				this.registerAccount(account, credential)
		};
		const remote = this.env?.HUB ? network(this.env, name, local) : undefined;
		return new PasskeyAuth(this.ctx.storage, this.env, remote);
	}
	async consumeCeremony(key: string): Promise<Ceremony | undefined> {
		return this.ctx.blockConcurrencyWhile(() =>
			this.auth().takeStoredCeremony(key)
		);
	}
	async registerAccount(
		account: Account,
		credential: WebAuthnCredential
	): Promise<void> {
		return this.ctx.blockConcurrencyWhile(() =>
			this.auth().storeAccount(account, credential)
		);
	}
	async sessionAccount(key: string) {
		return this.env?.HUB ? identity(this.env, key) : this.auth().identity(key);
	}

	async sessionIdentity(request: Request, session: Session) {
		const authKey = await this.auth().loginKey(request);
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
		if ((latest.turnCount ?? 0) >= 10) {
			return json({ error: TURN_LIMIT }, 429);
		}
		latest.turnCount = (latest.turnCount ?? 0) + 1;
		ws.serializeAttachment(latest);
		return this.iceServers();
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
			return this.createLink(ws, a, m.files);
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
		if (!('id' in m) || a.transfer !== m.id) {
			throw new Error('転送が見つかりません。');
		}
		await this.transferAction(a, m);
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
			await this.ctx.storage.delete(a.linkKey);
			delete a.linkKey;
			ws.serializeAttachment(a);
			send(ws, { type: 'link-ended' });
		}
	}

	async createLink(ws: WebSocket, a: Attachment, files: PhotoMeta[]) {
		await (this.env?.HUB
			? allowSend(this.env, a.authKey ?? '')
			: this.auth().allowSend(a.authKey ?? ''));
		this.checkRequestRate(ws, a);
		this.checkLinkParticipant(a);
		await this.revokeLink(ws, a);
		return this.issueLink(ws, a, files);
	}

	async issueLink(ws: WebSocket, a: Attachment, files: PhotoMeta[]) {
		const token = routedToken(
			await this.ctx.storage.get<string>('routing:room')
		);
		const link = newLink(a.session!.id, files);
		a.linkKey = 'link:' + (await hash(token));
		await this.storeLink(ws, a, link);
		send(ws, { type: 'link-created', token, expiresAt: link.expiresAt });
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
		await this.consumeLink({ ws, a, key, link: link!, owner });
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
		t.expiresAt = Date.now() + LIMITS.transferMs;
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
		if (a.transfer) {
			await this.end(a.transfer, 'disconnected');
		}
		await this.revokeLink(ws, a);
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
		if (a.transfer) {
			await this.end(a.transfer, 'timeout');
		}
		await this.revokeLink(ws, a);
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
		id: t.id,
		from: t.from,
		to: t.to,
		files: t.files
	};
}
function endReason(type: string): EndReason {
	return type === 'reject'
		? 'rejected'
		: type === 'complete'
			? 'complete'
			: 'cancelled';
}

type StoredIdentity = { key: string; session: StoredSession };
function currentRate(rate: Rate | undefined): Rate {
	return rate && rate.expiresAt > Date.now()
		? rate
		: { count: 0, expiresAt: Date.now() + 60_000 };
}

function firstExpiry(entries: Iterable<Expiring>) {
	let next = Infinity;
	for (const entry of entries) {
		if (typeof entry.expiresAt === 'number') {
			next = Math.min(next, entry.expiresAt);
		}
	}
	return next;
}

function requestWindow(old: Rate | undefined, kind: string): Rate {
	const duration = kind === 'auth' ? 600_000 : 60_000;
	return old && old.expiresAt > Date.now()
		? old
		: { count: 0, expiresAt: Date.now() + duration };
}
