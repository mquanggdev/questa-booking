import { ApiProperty } from '@nestjs/swagger';

export const QueueState = {
  /** This performance has no waiting room: hold tickets directly. */
  NOT_REQUIRED: 'NOT_REQUIRED',
  /** Not in the line (never joined, or the pass expired). */
  NONE: 'NONE',
  WAITING: 'WAITING',
  /** Holds tickets until expiresAt. */
  ADMITTED: 'ADMITTED',
} as const;
export type QueueState = (typeof QueueState)[keyof typeof QueueState];

export class QueueStatusDto {
  @ApiProperty({ enum: Object.values(QueueState) })
  status: QueueState;

  @ApiProperty({
    required: false,
    description: 'WAITING: your number in line (arrival order)',
  })
  number?: number;

  @ApiProperty({
    required: false,
    description: 'WAITING: 1 = admitted next. Equals number - admittedThrough',
  })
  position?: number;

  @ApiProperty({
    required: false,
    description: 'Number of the last person admitted (0 = nobody yet)',
  })
  admittedThrough?: number;

  @ApiProperty({ required: false, description: 'People still waiting' })
  waiting?: number;

  @ApiProperty({
    required: false,
    description:
      'WAITING: rough wait, from the admission pace and the time until the sale opens',
  })
  estimatedWaitSeconds?: number;

  @ApiProperty({
    required: false,
    description:
      'WAITING, for clients without the /queue WebSocket: ask GET /queue/me again after this long (1-30 s, sooner near the front)',
  })
  pollAfterMs?: number;

  @ApiProperty({
    required: false,
    description: 'ADMITTED: when the admission pass stops being accepted',
  })
  expiresAt?: Date;
}
