import type { WebAuthnCredential } from '@simplewebauthn/server';

export type Account = { id: string; name: string; disabled?: boolean };

export type Credential = { account: string; credential: WebAuthnCredential };

export type Login = { account: string; expiresAt: number };

export type Ceremony = {
	kind: 'register' | 'login';
	challenge: string;
	account?: Account;
	expiresAt: number;
};
