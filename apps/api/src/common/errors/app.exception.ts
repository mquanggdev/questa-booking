import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorBody, ErrorCode } from './error-codes.js';

// Domain error with a stable code. Services throw this; the global filter
// turns it into { code, message, details }.
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    const body: ErrorBody = { code, message, details };
    super(body, status);
  }
}
