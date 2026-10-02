// Machine-readable error codes returned in every error body as `code`.
// Clients branch on these, never on `message`.
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  CONCERT_NOT_FOUND: 'CONCERT_NOT_FOUND',
  PERFORMANCE_NOT_FOUND: 'PERFORMANCE_NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
