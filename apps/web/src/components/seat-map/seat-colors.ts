// Shared by the canvas and the legend; kept apart so the legend does not pull
// Konva into the server bundle.
export const SEAT_COLORS = {
  available: '#22c55e',
  selected: '#4f46e5',
  held: '#f59e0b',
  sold: '#94a3b8',
} as const;
