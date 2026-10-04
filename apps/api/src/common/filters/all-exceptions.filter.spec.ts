import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function capture(exception: unknown) {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter();
  // Silence the expected log lines in test output.
  Object.assign(filter, { logger: { warn: () => {}, error: () => {} } });
  filter.catch(exception, host);
  return res;
}

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
  });

describe('AllExceptionsFilter', () => {
  it('keeps the code of an AppException', () => {
    const res = capture(
      new AppException(HttpStatus.CONFLICT, ErrorCode.SOLD_OUT, 'gone', {
        a: 1,
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'SOLD_OUT',
      message: 'gone',
      details: { a: 1 },
    });
  });

  it('turns pool exhaustion (P2028) into 503 with Retry-After', () => {
    const res = capture(prismaError('P2028'));
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(res.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('maps an unexpected unique violation to 409', () => {
    expect(capture(prismaError('P2002')).statusCode).toBe(409);
  });

  it('never leaks internal errors', () => {
    const res = capture(new Error('secret stack detail'));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
