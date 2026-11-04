export type ErrorCode =
	| 'unauthorized'
	| 'forbidden'
	| 'rate-limit'
	| 'too-large'
	| 'unsupported'
	| 'conversion-failed'
	| 'unavailable';

export class ServiceError extends Error {
	constructor(
		public code: ErrorCode,
		message: string
	) {
		super(message);
	}
}
