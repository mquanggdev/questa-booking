import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { AppConfigService } from './config/app-config.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const port = app.get(AppConfigService).get('PORT');
  await app.listen(port, '0.0.0.0');
}

await bootstrap();
