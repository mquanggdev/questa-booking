import type { Redis } from 'ioredis';
import type { AppConfigService } from '../../config/app-config.service.js';
import type {
  AdmissionInfo,
  PerformancesService,
} from '../concerts/performances.service.js';
import { WaitingRoomService } from './waiting-room.service.js';

const info = (waitingRoomEnabled: boolean): AdmissionInfo => ({
  status: 'PUBLISHED',
  waitingRoomEnabled,
  openPhase: { id: 'phase', type: 'GENERAL' },
  saleAhead: true,
  opensAt: null,
});

function service(redis: Partial<Redis>, admission: AdmissionInfo | null) {
  const performances = {
    admissionInfo: vi.fn().mockResolvedValue(admission),
  };
  return new WaitingRoomService(
    redis as Redis,
    performances as unknown as PerformancesService,
    {} as AppConfigService,
  );
}

describe('WaitingRoomService.isAdmitted', () => {
  it('without a waiting room everyone is admitted, and Redis is not asked', async () => {
    const redis = { exists: vi.fn() };
    await expect(
      service(redis, info(false)).isAdmitted('p', 'u'),
    ).resolves.toBe(true);
    expect(redis.exists).not.toHaveBeenCalled();
  });

  it('with a waiting room, only a pass of this account and performance counts', async () => {
    const redis = {
      exists: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
    };
    const s = service(redis, info(true));
    await expect(s.isAdmitted('p', 'u')).resolves.toBe(true);
    await expect(s.isAdmitted('p', 'u')).resolves.toBe(false);
    expect(redis.exists).toHaveBeenCalledWith('wr:p:pass:u');
  });

  it('fails open: Redis down lets the hold through (PostgreSQL still decides it)', async () => {
    const redis = {
      exists: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    await expect(service(redis, info(true)).isAdmitted('p', 'u')).resolves.toBe(
      true,
    );
  });

  it('an unknown performance is left to the hold to answer (404)', async () => {
    await expect(service({}, null).isAdmitted('p', 'u')).resolves.toBe(true);
  });
});
