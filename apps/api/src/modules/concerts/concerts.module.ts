import { Module } from '@nestjs/common';
import { SeatsModule } from '../seats/seats.module.js';
import { CatalogCacheService } from './catalog-cache.service.js';
import { ConcertsController } from './concerts.controller.js';
import { ConcertsService } from './concerts.service.js';
import { PerformancesController } from './performances.controller.js';
import { PerformancesService } from './performances.service.js';
import { PresaleController } from './presale.controller.js';
import { PresaleService } from './presale.service.js';
import { ZonesService } from './zones.service.js';

// Concerts and their performances (with zones and sale phases) are one
// aggregate: a performance never exists without its concert.
@Module({
  imports: [SeatsModule],
  controllers: [ConcertsController, PerformancesController, PresaleController],
  providers: [
    ConcertsService,
    PerformancesService,
    ZonesService,
    CatalogCacheService,
    PresaleService,
  ],
  exports: [PerformancesService, ZonesService],
})
export class ConcertsModule {}
