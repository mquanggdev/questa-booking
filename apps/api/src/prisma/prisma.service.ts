import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL'),
        max: config.get('DB_POOL_MAX'),
      }),
      transactionOptions: {
        maxWait: config.get('DB_TX_MAX_WAIT_MS'),
        timeout: config.get('DB_TX_TIMEOUT_MS'),
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
