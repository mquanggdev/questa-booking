import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { hostname } from 'node:os';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import { AppConfigService } from './config/app-config.service.js';
import { MetricsService } from './metrics/metrics.service.js';

export const API_PREFIX = 'api/v1';

/** The container hostname: unique per replica in Docker. */
export const INSTANCE_ID = hostname();

// Shared by main.ts and the e2e tests, so tests exercise the exact same
// pipeline (prefix, validation, error format, cookies) as production.
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): void;
  };
  // Behind Nginx (phase 7a): take the client IP from X-Forwarded-For, but
  // only when the request comes from a loopback or private-network proxy.
  // A client on the internet cannot spoof its IP by sending the header.
  express.set('trust proxy', 'loopback, uniquelocal');
  // Which replica answered: lets tests and demos see the load balancing.
  app.use(
    (
      _req: unknown,
      res: { setHeader(k: string, v: string): void },
      next: () => void,
    ) => {
      res.setHeader('X-Instance', INSTANCE_ID);
      next();
    },
  );
  // Request duration by route template (phase 9). The route is known once
  // Express has matched it, so it is read when the response finishes.
  const metrics = app.get(MetricsService);
  app.use(
    (
      req: { method: string; baseUrl?: string; route?: { path: string } },
      res: { statusCode: number; once(e: 'finish', f: () => void): void },
      next: () => void,
    ) => {
      const stop = metrics.httpDuration.startTimer();
      res.once('finish', () =>
        stop({
          method: req.method,
          route: req.route
            ? `${req.baseUrl ?? ''}${req.route.path}`
            : 'unmatched',
          status: String(res.statusCode),
        }),
      );
      next();
    },
  );
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
