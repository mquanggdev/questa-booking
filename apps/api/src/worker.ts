import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

// Background process: BullMQ consumers only. Started with `node dist/worker.js`
// (docker compose service "worker").
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // Stop taking new jobs and finish the current one on SIGTERM.
  app.enableShutdownHooks();
  app.get(Logger).log('Worker started');
}

await bootstrap();
