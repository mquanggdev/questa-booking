import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, type ErrorBody } from '../errors/error-codes.js';

const codeByStatus: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.TOO_MANY_REQUESTS,
  503: ErrorCode.SERVICE_UNAVAILABLE,
};

// Every error leaves the API as { code, message, details? }.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);

    if (status >= 500) {
      this.logger.error(exception);
    }
    res.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        body: this.fromHttpException(exception),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // A unique constraint the service did not anticipate. Expected
      // conflicts are caught in services and given a specific code.
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          body: {
            code: ErrorCode.CONFLICT,
            message: 'Resource already exists',
          },
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          body: { code: ErrorCode.NOT_FOUND, message: 'Resource not found' },
        };
      }
    }

    // Never leak internals to clients; the full error is in the server log.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal server error',
      },
    };
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const response = exception.getResponse();
    if (isErrorBody(response)) {
      return response;
    }
    const status = exception.getStatus();
    const message =
      typeof response === 'string'
        ? response
        : typeof response === 'object' &&
            response !== null &&
            'message' in response &&
            typeof response.message === 'string'
          ? response.message
          : exception.message;
    return {
      code: codeByStatus[status] ?? ErrorCode.INTERNAL_ERROR,
      message,
    };
  }
}

function isErrorBody(value: unknown): value is ErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value
  );
}
