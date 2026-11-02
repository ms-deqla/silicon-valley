/**
 * Pure geometry for the office floor: cell size, floor offsets, room rectangles,
 * street, staircase and hit-testing. No DOM and nothing mutated, so it is unit
 * tested in test/unit-office-layout.test.ts.
 *
 * DESIGN.md section 5: a 6×8 grid per floor; floor 1 (when bought) is drawn
 * stacked ABOVE floor 0 with a staircase in the gap; the street door sits on the
 * bottom edge of the lobby (the garage before the lobby exists). Y grows downward.
 */
import { CONFIG } from '../../sim/config';
import type { Role, Room, RoomSize } from '../../sim/types';
import type { Pt } from './util';

/** height of the street strip below floor 0, in cells */
export const STREET_ROWS = 1.5;
/** height of the gap (holding the staircase) between the floors, in cells */
export const GAP_ROWS = 0.75;
/** back wall height and side wall width, in cells (DESIGN 3: short extruded walls) */
export const BACK_WALL = 0.35;
export const SIDE_WALL = 0.12;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  floor: 0 | 1;
  x: number;
  y: number;
}

export interface LayoutInput {
  /** canvas CSS size */
  width: number;
  height: number;
  floors: 1 | 2;
  /** CSS px kept free around the lot (default 0) */
  pad?: number;
  cols?: number;
  rowsPerFloor?: number;
}

export interface Layout {
  width: number;
  height: number;
  floors: 1 | 2;
  cols: number;
  rowsPerFloor: number;
  /** total rows drawn: floors × rowsPerFloor + street (+ gap) */
  rows: number;
  /** cell size in CSS px */
  cell: number;
  /** top-left of the drawn lot (floors + street), centred in the canvas */
  x0: number;
  y0: number;
  lotW: number;
  lotH: number;
  /** top edge of each floor's grid, indexed by floor number */
  floorTop: number[];
  /** the gap between the floors; gapH is 0 with one floor */
  gapTop: number;
  gapH: number;
  streetTop: number;
  streetH: number;
  /** the staircase, inside the gap, or null with one floor */
  stair: Rect | null;
}

export function computeLayout(input: LayoutInput): Layout {
  const cols = input.cols ?? CONFIG.grid.w;
  const rowsPerFloor = input.rowsPerFloor ?? CONFIG.grid.h;
  const pad = input.pad ?? 0;
  const floors = input.floors;
  const rows = rowsPerFloor * floors + STREET_ROWS + (floors === 2 ? GAP_ROWS : 0);
  const availW = Math.max(0, input.width - 2 * pad);
  const availH = Math.max(0, input.height - 2 * pad);
  const cell = Math.min(availW / cols, availH / rows);
  const lotW = cols * cell;
  const lotH = rows * cell;
  const x0 = (input.width - lotW) / 2;
  const y0 = (input.height - lotH) / 2;
  const floorH = rowsPerFloor * cell;
  let floorTop: number[];
  let gapTop: number;
  let gapH: number;
  if (floors === 2) {
    gapTop = y0 + floorH;
    gapH = GAP_ROWS * cell;
    floorTop = [gapTop + gapH, y0];
  } else {
    gapTop = y0;
    gapH = 0;
    floorTop = [y0];
  }
  const streetTop = floorTop[0] + floorH;
  const stair: Rect | null = floors === 2
    ? { x: x0 + (cols - 1.6) * cell, y: gapTop, w: 1.2 * cell, h: gapH }
    : null;
  return {
    width: input.width,
    height: input.height,
    floors,
    cols,
    rowsPerFloor,
    rows,
    cell,
    x0,
    y0,
    lotW,
    lotH,
    floorTop,
    gapTop,
    gapH,
    streetTop,
    streetH: STREET_ROWS * cell,
    stair,
  };
}

/** Alias so the task wording ("a layout function") maps onto one name. */
export { computeLayout as layout };

export function cellX(l: Layout, x: number): number {
  return l.x0 + x * l.cell;
}

export function cellY(l: Layout, floor: 0 | 1, y: number): number {
  return l.floorTop[floor] + y * l.cell;
}

/** Rectangle of a w×h block of cells; writes into `out` when given (no allocation per frame). */
export function rectOf(l: Layout, floor: 0 | 1, x: number, y: number, w: number, h: number, out?: Rect): Rect {
  const r = out ?? { x: 0, y: 0, w: 0, h: 0 };
  r.x = cellX(l, x);
  r.y = cellY(l, floor, y);
  r.w = w * l.cell;
  r.h = h * l.cell;
  return r;
}

export function cellRect(l: Layout, floor: 0 | 1, x: number, y: number, out?: Rect): Rect {
  return rectOf(l, floor, x, y, 1, 1, out);
}

export function roomRect(l: Layout, room: Room, out?: Rect): Rect {
  return rectOf(l, room.floor, room.x, room.y, room.w, room.h, out);
}

/** The whole grid of one floor. */
export function floorRect(l: Layout, floor: 0 | 1, out?: Rect): Rect {
  return rectOf(l, floor, 0, 0, l.cols, l.rowsPerFloor, out);
}

/** Footprint in cells of a room the player is about to place (DESIGN 5: small 2×2, large 3×2, demo 2×2). */
export function footprint(kind: Role | 'demo', size: RoomSize): { w: number; h: number } {
  if (kind === 'demo') return { w: CONFIG.rooms.demo.w, h: CONFIG.rooms.demo.h };
  const s = CONFIG.rooms.size[size];
  return { w: s.w, h: s.h };
}

/** Canvas point → grid cell on whichever floor contains it; null on the street, the gap or outside the lot. */
export function hitCell(l: Layout, px: number, py: number): Cell | null {
  if (!(l.cell > 0)) return null;
  if (px < l.x0 || px >= l.x0 + l.lotW) return null;
  const floorH = l.rowsPerFloor * l.cell;
  for (let f = 0; f < l.floors; f++) {
    const top = l.floorTop[f];
    if (py >= top && py < top + floorH) {
      return {
        floor: f as 0 | 1,
        x: Math.min(l.cols - 1, Math.floor((px - l.x0) / l.cell)),
        y: Math.min(l.rowsPerFloor - 1, Math.floor((py - top) / l.cell)),
      };
    }
  }
  return null;
}

export function roomAt(rooms: readonly Room[], floor: 0 | 1, x: number, y: number): Room | undefined {
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (r.floor === floor && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
  }
  return undefined;
}

/** Street door: centre of the lobby's bottom edge, or the garage's before the lobby exists (DESIGN 5). */
export function doorAnchor(l: Layout, hasLobby: boolean): Pt {
  const g = hasLobby ? CONFIG.grid.lobby : CONFIG.grid.garage;
  return { x: cellX(l, g.x + g.w / 2), y: cellY(l, 0, g.y + g.h) };
}

/** Where walkers step onto / off the staircase: just inside floor 0's top edge and floor 1's bottom edge. */
export function stairPoints(l: Layout): { bottom: Pt; top: Pt } | null {
  if (!l.stair || l.floors !== 2) return null;
  const cx = l.stair.x + l.stair.w / 2;
  return {
    bottom: { x: cx, y: l.floorTop[0] + 0.35 * l.cell },
    top: { x: cx, y: l.floorTop[1] + l.rowsPerFloor * l.cell - 0.35 * l.cell },
  };
}
