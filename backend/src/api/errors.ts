import { ServiceError, type ErrorCode } from '../application/errors.ts';
import { authJson } from './http.ts';
const statuses: Record<ErrorCode, number> = {
	unauthorized: 401,
	forbidden: 403,
	'rate-limit': 429,
	'too-large': 413,
	unsupported: 415,
	'conversion-failed': 422,
	unavailable: 503
};

export function serviceError(error: Error) {
	if (error instanceof ServiceError) {
		return authJson({ error: error.message }, statuses[error.code]);
	}
	return authJson({ error: 'Internal server error' }, 500);
}
