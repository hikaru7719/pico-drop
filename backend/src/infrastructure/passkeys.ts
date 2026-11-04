import {
	generateRegistrationOptions,
	generateAuthenticationOptions,
	verifyRegistrationResponse,
	verifyAuthenticationResponse
} from '@simplewebauthn/server';
import type { PasskeyVerifier } from '../application/auth.ts';

export const passkeys: PasskeyVerifier = {
	generateRegistrationOptions,
	generateAuthenticationOptions,
	verifyRegistrationResponse,
	verifyAuthenticationResponse
};
