import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';

export interface FieldError {
  field: string;
  errors: string[];
}

// Flattens nested class-validator errors into "zones.0.price" style paths.
export function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints
      ? [{ field, errors: Object.values(error.constraints) }]
      : [];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        flattenValidationErrors(errors),
      ),
  });
}
