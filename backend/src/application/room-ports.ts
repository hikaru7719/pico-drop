import type { KeyValueStore } from './auth.ts';
import type { Account } from '../domain/auth.ts';

export interface RecordStore extends KeyValueStore {
	list<T>(): Promise<Map<string, T>>;
	getAlarm(): Promise<number | null>;
	setAlarm(time: number): Promise<void>;
}

export interface RoomSocket {
	readonly readyState: number;
	send(message: string): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
}

export interface RoomRuntime {
	storage: RecordStore;
	getRoomSockets(): RoomSocket[];
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export type IceConfiguration = { iceServers: unknown[]; relay: boolean };

export interface RoomDependencies {
	identity(key: string): Promise<Account | undefined>;
	allowSend(key: string): Promise<Account>;
	iceServers(): Promise<IceConfiguration>;
}

export type SessionInput = { room?: string; authKey: string };
