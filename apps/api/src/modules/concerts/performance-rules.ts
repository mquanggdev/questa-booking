import type { FieldError } from '../../common/pipes/validation.pipe.js';
import { ZoneType } from '../../generated/prisma/client.js';
import type { CreatePerformanceDto } from './dto/performance.dto.js';

// Upper bound per performance; the seeded stadium nights use 8,000 seats.
export const MAX_SEATS_PER_PERFORMANCE = 20_000;

/**
 * Cross-field rules that class-validator cannot express on a single field.
 * Returns every problem at once so the client can fix them in one go.
 */
export function validatePerformanceRules(
  dto: CreatePerformanceDto,
  now: Date = new Date(),
): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) =>
    errors.push({ field, errors: [message] });

  if (dto.startsAt <= now) {
    add('startsAt', 'startsAt must be in the future');
  }

  const names = new Set<string>();
  let seatCount = 0;
  dto.zones.forEach((zone, i) => {
    const key = zone.name.toLowerCase();
    if (names.has(key)) {
      add(`zones.${i}.name`, `zone name "${zone.name}" is used twice`);
    }
    names.add(key);
    if (zone.type === ZoneType.SEATED && zone.capacity !== undefined) {
      add(
        `zones.${i}.capacity`,
        'SEATED zones take rows and seatsPerRow, not capacity',
      );
    }
    if (
      zone.type === ZoneType.STANDING &&
      (zone.rows !== undefined || zone.seatsPerRow !== undefined)
    ) {
      add(
        `zones.${i}`,
        'STANDING zones take capacity, not rows or seatsPerRow',
      );
    }
    if (zone.type === ZoneType.SEATED) {
      seatCount += (zone.rows ?? 0) * (zone.seatsPerRow ?? 0);
    }
  });
  if (seatCount > MAX_SEATS_PER_PERFORMANCE) {
    add('zones', `at most ${MAX_SEATS_PER_PERFORMANCE} seats per performance`);
  }

  const phases = dto.salePhases
    .map((phase, i) => ({ startsAt: phase.startsAt, endsAt: phase.endsAt, i }))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  phases.forEach((phase, k) => {
    if (phase.endsAt <= phase.startsAt) {
      add(`salePhases.${phase.i}.endsAt`, 'endsAt must be after startsAt');
    }
    if (phase.endsAt > dto.startsAt) {
      add(
        `salePhases.${phase.i}.endsAt`,
        'a sale phase must end before the performance starts',
      );
    }
    const previous = phases[k - 1];
    if (previous && phase.startsAt < previous.endsAt) {
      add(`salePhases.${phase.i}`, 'sale phases must not overlap');
    }
  });

  return errors;
}
