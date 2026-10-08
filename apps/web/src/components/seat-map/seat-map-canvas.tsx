'use client';

import type Konva from 'konva';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Stage, Text } from 'react-konva';
import type { Schemas } from '@/lib/api/client';
import { formatVnd } from '@/lib/format';
import { SEAT_COLORS } from './seat-colors';

type Seat = Schemas['SeatResponseDto'];
type Zone = Schemas['ZoneAvailabilityDto'];

const PITCH = 14; // distance between seat centres, px
const RADIUS = 5.5;
const ROW_LABEL_WIDTH = 28;
const ZONE_GAP = 36;

interface PlacedSeat extends Seat {
  x: number;
  y: number;
}

interface ZoneBlock {
  zone: Zone;
  y: number;
  rows: { label: string; y: number }[];
}

/** Natural row order: A..Z, then AA, AB... */
const byRowLabel = (a: string, b: string) =>
  a.length - b.length || a.localeCompare(b);

function layout(zones: Zone[], seats: Seat[]) {
  const placed: PlacedSeat[] = [];
  const blocks: ZoneBlock[] = [];
  let y = 24;
  let width = 0;
  for (const zone of zones.filter((z) => z.type === 'SEATED')) {
    const mine = seats.filter((s) => s.zoneId === zone.id);
    const rowLabels = [...new Set(mine.map((s) => s.row))].sort(byRowLabel);
    const block: ZoneBlock = { zone, y, rows: [] };
    y += 22;
    for (const label of rowLabels) {
      const row = mine
        .filter((s) => s.row === label)
        .sort((a, b) => a.number - b.number);
      for (const seat of row) {
        const x = ROW_LABEL_WIDTH + seat.number * PITCH;
        placed.push({ ...seat, x, y });
        width = Math.max(width, x + PITCH);
      }
      block.rows.push({ label, y });
      y += PITCH;
    }
    blocks.push(block);
    y += ZONE_GAP;
  }
  return { placed, blocks, width, height: y };
}

interface Props {
  zones: Zone[];
  seats: Seat[];
  selected: ReadonlySet<string>;
  onToggle(seat: Seat): void;
}

export default function SeatMapCanvas({
  zones,
  seats,
  selected,
  onToggle,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [hovered, setHovered] = useState<PlacedSeat | null>(null);
  const { placed, blocks, width, height } = useMemo(
    () => layout(zones, seats),
    [zones, seats],
  );
  const prices = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setContainerWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit the whole map to the container width; the user can zoom from there.
  const fit =
    width > 0 && containerWidth > 0 ? Math.min(containerWidth / width, 1.6) : 1;
  const stageHeight = Math.min(height * fit, 560);

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const old = stage.scaleX();
    const next = Math.min(
      Math.max(old * (e.evt.deltaY > 0 ? 0.9 : 1.1), fit * 0.5),
      4,
    );
    const anchor = {
      x: (pointer.x - stage.x()) / old,
      y: (pointer.y - stage.y()) / old,
    };
    stage.scale({ x: next, y: next });
    stage.position({
      x: pointer.x - anchor.x * next,
      y: pointer.y - anchor.y * next,
    });
  };

  return (
    <div
      ref={container}
      className="relative w-full overflow-hidden rounded-lg border bg-muted/30"
    >
      {containerWidth > 0 && (
        <Stage
          width={containerWidth}
          height={stageHeight}
          scaleX={fit}
          scaleY={fit}
          draggable
          onWheel={onWheel}
        >
          <Layer listening={false}>
            {blocks.map((block) => (
              <Group key={block.zone.id}>
                <Text
                  x={ROW_LABEL_WIDTH}
                  y={block.y}
                  text={`${block.zone.name} · ${formatVnd(block.zone.price)}`}
                  fontSize={13}
                  fontStyle="bold"
                  fill="#334155"
                />
                {block.rows.map((row) => (
                  <Text
                    key={row.label}
                    x={2}
                    y={row.y - 6}
                    text={row.label}
                    fontSize={10}
                    fill="#64748b"
                  />
                ))}
              </Group>
            ))}
          </Layer>
          <SeatLayer
            seats={placed}
            selected={selected}
            onToggle={onToggle}
            onHover={setHovered}
          />
        </Stage>
      )}
      {hovered && (
        <div className="pointer-events-none absolute top-2 right-2 rounded-md bg-background/95 px-3 py-2 text-xs shadow">
          {prices.get(hovered.zoneId)?.name} · hàng {hovered.row}, ghế{' '}
          {hovered.number}
          <br />
          {formatVnd(prices.get(hovered.zoneId)?.price ?? 0)} ·{' '}
          {hovered.status === 'AVAILABLE'
            ? 'còn trống'
            : hovered.status === 'HELD'
              ? 'đang có người giữ'
              : 'đã bán'}
        </div>
      )}
    </div>
  );
}

// Thousands of shapes: memoised so hovering (tooltip state above) does not
// re-render every seat.
const SeatLayer = memo(function SeatLayer({
  seats,
  selected,
  onToggle,
  onHover,
}: {
  seats: PlacedSeat[];
  selected: ReadonlySet<string>;
  onToggle(seat: Seat): void;
  onHover(seat: PlacedSeat | null): void;
}) {
  return (
    <Layer>
      {seats.map((seat) => {
        const isSelected = selected.has(seat.id);
        const color = isSelected
          ? SEAT_COLORS.selected
          : seat.status === 'AVAILABLE'
            ? SEAT_COLORS.available
            : seat.status === 'HELD'
              ? SEAT_COLORS.held
              : SEAT_COLORS.sold;
        return (
          <Circle
            key={seat.id}
            name={`seat-${seat.row}${seat.number}`}
            x={seat.x}
            y={seat.y}
            radius={RADIUS}
            fill={color}
            perfectDrawEnabled={false}
            onClick={() => onToggle(seat)}
            onTap={() => onToggle(seat)}
            onMouseEnter={(e) => {
              onHover(seat);
              const stage = e.target.getStage();
              if (stage && seat.status === 'AVAILABLE')
                stage.container().style.cursor = 'pointer';
            }}
            onMouseLeave={(e) => {
              onHover(null);
              const stage = e.target.getStage();
              if (stage) stage.container().style.cursor = 'default';
            }}
          />
        );
      })}
    </Layer>
  );
});
