import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import { AppConfigService } from './config/app-config.service.js';

export const API_PREFIX = 'api/v1';

// Shared by main.ts and the e2e tests, so tests exercise the exact same
// pipeline (prefix, validation, error format, cookies) as production.
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX);
  app.use(cookieParser());
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (app.get(AppConfigService).get('SWAGGER_ENABLED')) {
    const document = createOpenApiDocument(app);
    SwaggerModule.setup('api/docs', app, document, {
      jsonDocumentUrl: 'api/docs/openapi.json',
    });
  }
}

/**
 * The OpenAPI description of every route. Response schemas come from the
 * @nestjs/swagger CLI plugin (nest-cli.json), which reads the controllers'
 * return types at build time. Also exported to openapi.json for the web app.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Questa Booking API')
    .setDescription(
      'High-concurrency concert ticketing. Errors are always { code, message, details? }.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('refresh_token')
    .build();
  return SwaggerModule.createDocument(app, config);
}
