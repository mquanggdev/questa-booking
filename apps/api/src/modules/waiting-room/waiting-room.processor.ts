import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  WAITING_ROOM_QUEUE,
  WaitingRoomJob,
} from '../../queue/queue.constants.js';
import { WaitingRoomService } from './waiting-room.service.js';

/**
 * Worker only. One repeating job admits every line's next batch; BullMQ
 * runs one job at a time here, so there is exactly one admitter even with
 * several workers, and two ticks never overlap.
 */
@Processor(WAITING_ROOM_QUEUE)
export class WaitingRoomProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(WaitingRoomProcessor.name);

  constructor(
    private readonly waitingRoom: WaitingRoomService,
    private readonly config: AppConfigService,
    @InjectQueue(WAITING_ROOM_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      WaitingRoomJob.ADMIT_BATCH,
      { every: this.config.get('WAITING_ROOM_TICK_MS') },
      // A tick that fails is simply replaced by the next one.
      { name: WaitingRoomJob.ADMIT_BATCH, opts: { attempts: 1 } },
    );
    this.logger.log('Waiting room schedule registered');
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== WaitingRoomJob.ADMIT_BATCH) {
      this.logger.warn(`Unknown job ${job.name}`);
      return null;
    }
    return this.waitingRoom.admitBatch();
  }
}
