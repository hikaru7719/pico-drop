import { DurableObject } from 'cloudflare:workers';
import {
	LIMITS,
	nearby,
	parseClient,
	authorizeTransfer,
	type Location,
	type ServerMessage,
	type Session,
	type TransferState
} from '../../shared/protocol.ts';

type Bindings = Env & { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string };
type Attachment = {
	connectedAt: number;
	session?: Omit<Session, 'token'>;
	location?: Location;
	seen?: number;
	transfer?: string;
	window?: number;
	messages?: number;
	requests?: number;
	lastPresence?: number;
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

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/api/health')
			return json({ status: 'ok', service: 'pico-drop-backend' });
		// Frontend forwards the original URL through a service binding; dev proxy preserves Host.
		if (request.headers.get('Origin') !== url.origin)
			return json({ error: 'Origin not allowed' }, 403);
		if (!['/api/session', '/api/ws', '/api/ice'].includes(url.pathname))
			return json({ error: 'Not found' }, 404);
		return env.HUB.get(env.HUB.idFromName('mvp')).fetch(request);
	}
} satisfies ExportedHandler<Bindings>;

export class NearbyHub extends DurableObject<Bindings> {
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (
			path === '/api/ws' &&
			request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
		) {
			if (this.ctx.getWebSockets().length >= 200)
				return json({ error: '混み合っています。後でお試しください。' }, 503);
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);
			pair[1].serializeAttachment({
				connectedAt: Date.now()
			} satisfies Attachment);
			await this.schedule();
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		if (path === '/api/session' && request.method === 'POST') {
			return this.ctx.blockConcurrencyWhile(async () => {
				const key =
					'rate:' +
					(await hash(request.headers.get('CF-Connecting-IP') ?? 'local'));
				const rate = await this.ctx.storage.get<{
					count: number;
					expiresAt: number;
				}>(key);
				const current =
					rate && rate.expiresAt > Date.now()
						? rate
						: { count: 0, expiresAt: Date.now() + 60_000 };
				if (++current.count > 20)
					return json(
						{ error: '接続回数が多すぎます。1分後に再試行してください。' },
						429
					);
				await this.ctx.storage.put(key, current);
				const token = Array.from(
					crypto.getRandomValues(new Uint8Array(32)),
					(x) => x.toString(16).padStart(2, '0')
				).join('');
				const id = crypto.randomUUID();
				const session: Session = {
					id,
					token,
					name: `ゲスト ${id.slice(0, 4).toUpperCase()}`,
					expiresAt: Date.now() + LIMITS.sessionMs
				};
				const { token: _token, ...stored } = session;
				await this.ctx.storage.put('session:' + (await hash(token)), stored);
				await this.schedule();
				return json(session, 201);
			});
		}
		if (path === '/api/ice' && request.method === 'POST') {
			const token =
				request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
			if (!/^[a-f0-9]{64}$/.test(token))
				return json({ error: 'Unauthorized' }, 401);
			const session = await this.ctx.storage.get<Omit<Session, 'token'>>(
				'session:' + (await hash(token))
			);
			const ws = session && this.socket(session.id);
			if (!session || session.expiresAt <= Date.now() || !ws)
				return json({ error: 'Unauthorized' }, 401);
			const a = this.attachment(ws);
			const t =
				a.transfer &&
				(await this.ctx.storage.get<TransferState>('transfer:' + a.transfer));
			if (!t || !t.started || t.expiresAt <= Date.now())
				return json({ error: '転送の確認が必要です。' }, 403);
			// The attachment survives hibernation; a session can mint at most ten credentials.
			const latest = this.attachment(ws);
			if ((latest.turnCount ?? 0) >= 10)
				return json(
					{ error: '接続設定の取得上限です。再接続してください。' },
					429
				);
			latest.turnCount = (latest.turnCount ?? 0) + 1;
			ws.serializeAttachment(latest);
			if (!this.env.TURN_KEY_ID || !this.env.TURN_KEY_API_TOKEN)
				return json({
					iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
					relay: false
				});
			try {
				const response = await fetch(
					`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
					{
						method: 'POST',
						headers: {
							Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({ ttl: 900 }),
						signal: AbortSignal.timeout(10_000)
					}
				);
				if (!response.ok) throw new Error('TURN');
				const data = (await response.json()) as { iceServers: unknown[] };
				return json({ iceServers: data.iceServers, relay: true });
			} catch {
				return json(
					{ error: '中継サーバーの準備に失敗しました。再試行してください。' },
					503
				);
			}
		}
		return json({ error: 'Method not allowed' }, 405);
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
		if ((await this.ctx.storage.getAlarm()) === null)
			await this.ctx.storage.setAlarm(Date.now() + 15_000);
	}
	isPresent(a: Attachment) {
		return (
			!!a.session &&
			a.session.expiresAt > Date.now() &&
			!!a.location &&
			(a.seen ?? 0) > Date.now() - LIMITS.presenceMs
		);
	}
	broadcast() {
		const sockets = this.ctx.getWebSockets();
		for (const ws of sockets) {
			const a = this.attachment(ws);
			if (!a.session) continue;
			const devices = this.isPresent(a)
				? sockets.flatMap((other) => {
						const b = this.attachment(other);
						return other !== ws &&
							other.readyState === WebSocket.OPEN &&
							this.isPresent(b) &&
							nearby(a.location!, b.location!)
							? [{ id: b.session!.id, name: b.session!.name }]
							: [];
					})
				: [];
			send(ws, { type: 'nearby', devices });
		}
	}
	async end(
		id: string,
		reason: Extract<ServerMessage, { type: 'ended' }>['reason']
	) {
		const t = await this.ctx.storage.get<TransferState>('transfer:' + id);
		if (!t) return;
		await this.ctx.storage.delete('transfer:' + id);
		for (const device of [t.from, t.to]) {
			const ws = this.socket(device.id);
			if (!ws) continue;
			const a = this.attachment(ws);
			if (a.transfer === id) {
				delete a.transfer;
				ws.serializeAttachment(a);
			}
			send(ws, { type: 'ended', id, reason });
		}
	}
	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		await this.ctx.blockConcurrencyWhile(async () => {
			try {
				if (typeof raw !== 'string' || raw.length > 24_000)
					throw new Error('制御メッセージのみ送信できます。');
				let a = this.attachment(ws);
				if (!a.window || a.window < Date.now() - 60_000) {
					a.window = Date.now();
					a.messages = 0;
					a.requests = 0;
				}
				a.messages = (a.messages ?? 0) + 1;
				ws.serializeAttachment(a);
				if (a.messages > 240) {
					ws.close(1008, 'Rate limit');
					return;
				}
				const m = parseClient(JSON.parse(raw));
				if (m.type === 'auth' && !a.session) {
					const key = 'session:' + (await hash(m.token));
					const session = await this.ctx.storage.get<
						Omit<Session, 'token'> & { used?: boolean }
					>(key);
					if (
						!session ||
						session.used ||
						session.expiresAt <= Date.now() ||
						this.socket(session.id)
					) {
						ws.close(1008, 'Invalid session');
						return;
					}
					// A token authenticates one socket; reconnect obtains a fresh anonymous session.
					await this.ctx.storage.put(key, { ...session, used: true });
					a.session = {
						id: session.id,
						name: session.name,
						expiresAt: session.expiresAt
					};
					ws.serializeAttachment(a);
					send(ws, {
						type: 'ready',
						device: { id: session.id, name: session.name }
					});
					return;
				}
				if (!a.session || a.session.expiresAt <= Date.now()) {
					ws.close(1008, 'Session expired');
					return;
				}
				if (m.type === 'presence') {
					if (
						m.location &&
						a.location &&
						(a.lastPresence ?? 0) > Date.now() - 2000
					)
						return;
					a.lastPresence = Date.now();
					a.seen = Date.now();
					if (m.location) a.location = m.location;
					else delete a.location;
					ws.serializeAttachment(a);
					this.broadcast();
					return;
				}
				if (m.type === 'request') {
					a.requests = (a.requests ?? 0) + 1;
					ws.serializeAttachment(a);
					if (a.requests > 5)
						throw new Error(
							'送信要求が多すぎます。1分後に再試行してください。'
						);
					const other = this.socket(m.to);
					const b = other && this.attachment(other);
					if (
						!other ||
						!b ||
						other === ws ||
						!this.isPresent(a) ||
						!this.isPresent(b) ||
						!nearby(a.location!, b.location!)
					)
						throw new Error(
							'相手が見つかりません。近くの端末を再検索してください。'
						);
					if (a.transfer || b.transfer)
						throw new Error('転送中です。完了後にお試しください。');
					const t: TransferState = {
						id: crypto.randomUUID(),
						from: { id: a.session.id, name: a.session.name },
						to: { id: b.session!.id, name: b.session!.name },
						files: m.files,
						started: false,
						expiresAt: Date.now() + LIMITS.requestMs
					};
					await this.ctx.storage.put('transfer:' + t.id, t);
					a.transfer = t.id;
					b.transfer = t.id;
					ws.serializeAttachment(a);
					other.serializeAttachment(b);
					const message = {
						type: 'requested' as const,
						id: t.id,
						from: t.from,
						to: t.to,
						files: t.files
					};
					send(ws, message);
					send(other, message);
					return;
				}
				if (!('id' in m) || a.transfer !== m.id)
					throw new Error('転送が見つかりません。');
				const t = await this.ctx.storage.get<TransferState>('transfer:' + m.id);
				if (!t) throw new Error('転送が期限切れです。');
				authorizeTransfer(t, a.session.id, m.type);
				if (
					m.type === 'reject' ||
					m.type === 'cancel' ||
					m.type === 'complete'
				) {
					await this.end(
						t.id,
						m.type === 'reject'
							? 'rejected'
							: m.type === 'complete'
								? 'complete'
								: 'cancelled'
					);
					return;
				}
				if (m.type === 'signal') {
					const other = this.socket(
						a.session.id === t.from.id ? t.to.id : t.from.id
					);
					if (other)
						send(other, { type: 'signal', id: t.id, signal: m.signal });
					return;
				}
				if (m.type === 'accept') {
					t.started = true;
					t.expiresAt = Date.now() + LIMITS.transferMs;
					await this.ctx.storage.put('transfer:' + t.id, t);
					for (const device of [t.from, t.to]) {
						const other = this.socket(device.id);
						if (other) send(other, { type: 'start', id: t.id });
					}
				}
			} catch (e) {
				send(ws, {
					type: 'error',
					message: e instanceof Error ? e.message : '処理に失敗しました。'
				});
			}
		});
	}
	async webSocketClose(ws: WebSocket) {
		const a = this.attachment(ws);
		if (a.transfer) await this.end(a.transfer, 'disconnected');
		ws.close();
		this.broadcast();
	}
	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws);
	}
	async alarm() {
		await this.ctx.blockConcurrencyWhile(async () => {
			const now = Date.now();
			for (const ws of this.ctx.getWebSockets()) {
				const a = this.attachment(ws);
				if (
					(!a.session && a.connectedAt < now - 10_000) ||
					(a.session && a.session.expiresAt <= now)
				) {
					if (a.transfer) await this.end(a.transfer, 'timeout');
					ws.close(1008, 'Session expired');
				} else if (a.location && (a.seen ?? 0) < now - LIMITS.presenceMs) {
					delete a.location;
					ws.serializeAttachment(a);
				}
			}
			const entries = await this.ctx.storage.list<{ expiresAt: number }>();
			for (const [key, value] of entries)
				if (value.expiresAt <= now) {
					if (key.startsWith('transfer:'))
						await this.end(key.slice(9), 'timeout');
					else await this.ctx.storage.delete(key);
				}
			this.broadcast();
			if (
				this.ctx.getWebSockets().length ||
				(await this.ctx.storage.list({ limit: 1 })).size
			)
				await this.ctx.storage.setAlarm(now + 15_000);
		});
	}
}
