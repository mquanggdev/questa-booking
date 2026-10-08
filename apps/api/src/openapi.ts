// Writes the API's OpenAPI document to a file, without a database or Redis:
// preview mode builds the module graph but never instantiates providers.
//
//   pnpm --filter @questa/api openapi:export      (-> apps/api/openapi.json)
//
// Must run from the build output (dist/): the @nestjs/swagger plugin adds the
// response schemas while compiling.
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The document depends on routes and DTOs only, never on configuration
// values, but the config module validates at import time. Placeholders let
// the export run where no .env exists (CI); real values are left untouched.
process.env.DATABASE_URL ??=
  'postgresql://openapi:openapi@localhost:5432/openapi';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??=
  'openapi-export-placeholder-secret-0123456789';

// Imported after the placeholders are set.
const { AppModule } = await import('./app.module.js');
const { API_PREFIX, createOpenApiDocument } = await import('./app.setup.js');

const output = resolve(process.argv[2] ?? 'openapi.json');
const app = await NestFactory.create(AppModule, {
  preview: true,
  logger: ['error'],
  // Throw instead of process.exit(1), so a failure prints its cause.
  abortOnError: false,
});
app.setGlobalPrefix(API_PREFIX);
const document = createOpenApiDocument(app);
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
console.log(`OpenAPI document written to ${output}`);
