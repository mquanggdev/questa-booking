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
import { AppModule } from './app.module.js';
import { API_PREFIX, createOpenApiDocument } from './app.setup.js';

const output = resolve(process.argv[2] ?? 'openapi.json');
const app = await NestFactory.create(AppModule, {
  preview: true,
  logger: false,
});
app.setGlobalPrefix(API_PREFIX);
const document = createOpenApiDocument(app);
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
console.log(`OpenAPI document written to ${output}`);
