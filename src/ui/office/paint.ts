/**
 * The painter: draws one frame of the office floor from the cached layout,
 * the cached scene, the crowd and a few per-frame numbers. The static ground
 * (grass, scenery, lot slabs, street) is rendered once per layout into an
 * offscreen layer and blitted; everything else that can be precomputed
 * (fonts, dashes, tints, label widths, scenery positions) is cached, so the
 * per-frame path allocates nothing beyond what the canvas API itself does.
 * Without a DOM (unit tests) the ground is drawn directly every frame.
 * DESIGN.md sections 3 (art register), 5 (building), 13 (crowd).
 */
import type { PlacementMode } from '../api';
import { BACK_WALL, SIDE_WALL, cellRect, footprint, rectOf } from './layout';
import type { Layout, Rect } from './layout';
import type { RoomView, Scene, SeatInfo } from './scene';
import type { Crowd, Effect, Walker } from './walkers';
import * as P from './palette';
import {
  FONT, OUTLINE, circle, circleO, clearShadow, drawFigure, drawGlyph, ellipse, fillRR, fillStrokeRR, line, ring, rr,
  shadowRR, strokeRR,
} from './primitives';
import type { Ctx } from './primitives';
import { clamp, easeInOutQuad, easeOutCubic, formatMoney, hash2 } from './util';

export interface FrameInfo {
  /** seconds since the renderer was created (wall clock, dt-accumulated) */
  time: number;
  /** open receivables, for the "Owed to you" sign */
  ar: number;
  openInvoices: number;
  placement: PlacementMode | null;
  selectedRoomId: string | null;
  /** the placement spot under a pressed pointer (footprint ghost) */
  pressedSpot: { x: number; y: number } | null;
}

/** a round pastel tree, or a flatter shrub, beside the lot */
interface Tree {
  x: number;
  y: number;
  r: number;
  shrub: boolean;
  fill: string;
  light: string;
}

/** a darker patch of grass */
interface Blob {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/** a parked car on the street: a side-on silhouette, facing dir */
interface Car {
  x: number;
  /** where the wheels touch the road */
  y: number;
  dir: 1 | -1;
  fill: string;
}

export interface Painter {
  ctx: Ctx;
  cell: number;
  /** backing-store px per CSS px, set by the renderer; the ground layer is rendered at this scale */
  scaleX: number;
  scaleY: number;
  fontLabel: string;
  fontSign: string;
  fontCoin: string;
  fontBadge: string;
  /** px size of fontSign, so the sign box grows with the font's 9px floor on small cells */
  signFontPx: number;
  dash: number[];
  noDash: number[];
  roadDash: number[];
  /** gradients, rebuilt when the layout (or the context that draws them) changes */
  grass: CanvasGradient | null;
  road: CanvasGradient | null;
  gradFor: Layout | null;
  gradCtx: Ctx | null;
  signText: string;
  signAr: number;
  signW: number;
  stairShades: string[];
  tmp: Rect;
  /** scenery placed around the lot, rebuilt when the layout changes */
  decorFor: Layout | null;
  trees: Tree[];
  blobs: Blob[];
  cars: Car[];
  /** the offscreen ground layer; null without a DOM, then the ground is drawn directly each frame */
  ground: HTMLCanvasElement | null;
  groundCtx: Ctx | null;
  groundFor: Layout | null;
  groundDoorX: number;
  groundScaleX: number;
  groundScaleY: number;
}

const STAIR_STEPS = 6;
const MAX_PAPERS = 12;
/** a shipped feature throws 12 confetti rectangles in department colours */
const CONFETTI_N = 12;
/** a churned customer leaves in a puff of three grey circles */
const PUFF_N = 3;
const ZEBRA_N = 5;
/** figure heights in cells (DESIGN 3: big-headed figures, head ≈ 45% of the height) */
const WALKER_H = 0.6;
const SEAT_H = 0.55;
/** pavement strip between the lot and the road, in cells */
const PAVE = 0.55;
const TREE_FILLS = ['#86C47A', '#74B86A', '#9BD08A'];
const ROAD_NEAR = P.mix(P.STREET, '#FFFFFF', 0.08);
const ROAD_FAR = P.mix(P.STREET, '#2E3448', 0.14);
const TRUNK = '#8E6B4A';
const DESK_TOP = '#DCC39B';
const CHAIR = '#3F4553';
const CHAIR_PAD = '#555B6B';
const SCREEN_DARK = '#3C4252';
const SCREEN_LIT = '#9CC4F4';

export function createPainter(ctx: Ctx): Painter {
  const shades: string[] = [];
  for (let i = 0; i < STAIR_STEPS; i++) shades.push(P.mix('#F3EFE8', '#CDC6BB', i / (STAIR_STEPS - 1)));
  let ground: HTMLCanvasElement | null = null;
  let groundCtx: Ctx | null = null;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const cv = document.createElement('canvas');
      const g = cv.getContext('2d');
      if (g) {
        ground = cv;
        groundCtx = g;
      }
    } catch {
      // no offscreen layer: the ground is drawn directly each frame
    }
  }
  const p: Painter = {
    ctx,
    cell: 0,
    scaleX: 1,
    scaleY: 1,
    fontLabel: '',
    fontSign: '',
    fontCoin: '',
    fontBadge: '',
    signFontPx: 9,
    dash: [4, 3],
    noDash: [],
    roadDash: [12, 10],
    grass: null,
    road: null,
    gradFor: null,
    gradCtx: null,
    signText: '',
    signAr: NaN,
    signW: -1,
    stairShades: shades,
    tmp: { x: 0, y: 0, w: 0, h: 0 },
    decorFor: null,
    trees: [],
    blobs: [],
    cars: [],
    ground,
    groundCtx,
    groundFor: null,
    groundDoorX: NaN,
    groundScaleX: 0,
    groundScaleY: 0,
  };
  setPainterCell(p, 40);
  return p;
}

/** Fonts and dash patterns scale with the cell; call when the layout changes. */
export function setPainterCell(p: Painter, cell: number): void {
  p.cell = cell;
  p.fontLabel = `600 ${Math.max(10, Math.round(cell * 0.21))}px ${FONT}`;
  p.signFontPx = Math.max(9, Math.round(cell * 0.16));
  p.fontSign = `700 ${p.signFontPx}px ${FONT}`;
  p.fontCoin = `800 ${Math.max(11, Math.round(cell * 0.25))}px ${FONT}`;
  p.fontBadge = `700 ${Math.max(9, Math.round(cell * 0.16))}px ${FONT}`;
  p.dash = [Math.max(3, cell * 0.12), Math.max(3, cell * 0.09)];
  p.roadDash = [Math.max(6, cell * 0.5), Math.max(5, cell * 0.4)];
  p.signAr = NaN;
  p.signW = -1;
  p.groundFor = null;
}

/** The backing-store scale (device pixel ratio × the shell's column scale) the ground layer must match. */
export function setPainterScale(p: Painter, scaleX: number, scaleY: number): void {
  p.scaleX = scaleX > 0 ? scaleX : 1;
  p.scaleY = scaleY > 0 ? scaleY : 1;
}

export function paintFrame(p: Painter, l: Layout, scene: Scene, crowd: Crowd, info: FrameInfo): void {
  if (p.decorFor !== l) buildDecor(p, l);
  paintGround(p, l, scene.anchors.door.x);
  for (let i = 0; i < scene.rooms.length; i++) paintRoom(p, l, scene, scene.rooms[i], crowd, info);
  paintDoor(p, l, scene);
  if (scene.lobby && info.ar > 0) paintSign(p, l, scene, info);
  if (info.selectedRoomId) paintSelection(p, l, scene, info);
  paintWalkers(p, l, crowd);
  paintEffects(p, l, crowd);
  if (info.placement) paintPlacement(p, l, info.placement, info.pressedSpot);
}

// ---------------------------------------------------------------- ground (static per layout)

/** Hand-placed scenery around the lot, in the grass margins and on the street; allocated once per layout. */
function buildDecor(p: Painter, l: Layout): void {
  p.decorFor = l;
  p.trees.length = 0;
  p.blobs.length = 0;
  p.cars.length = 0;
  const c = l.cell;
  if (!(c > 0)) return;
  /** grass margin either side of the lot (the lot is centred) */
  const m = l.x0;
  const xl = m * 0.5;
  const xr = l.width - m * 0.5;
  const top = l.y0;
  const f0 = l.floorTop[0];
  const r = Math.min(0.5 * c, m * 0.34);
  if (r >= 3) {
    addTree(p, xl, top + 0.8 * c, r, false, 0);
    addTree(p, xr, top + 2.5 * c, r * 0.9, false, 1);
    addTree(p, xl, f0 + 4.4 * c, r * 0.8, true, 2);
    addTree(p, xr, f0 + 6.5 * c, r, false, 0);
    addTree(p, xr, f0 + 0.7 * c, r * 0.7, true, 1);
  }
  if (m > 8) {
    p.blobs.push({ x: xl - m * 0.15, y: top + 3.4 * c, rx: m * 0.6, ry: 0.7 * c });
    p.blobs.push({ x: xr + m * 0.1, y: f0 + 2.0 * c, rx: m * 0.55, ry: 0.8 * c });
    p.blobs.push({ x: xl - m * 0.2, y: f0 + 6.9 * c, rx: m * 0.65, ry: 0.6 * c });
    p.blobs.push({ x: xr + m * 0.15, y: top + 5.2 * c, rx: m * 0.5, ry: 0.65 * c });
  }
  // parked cars on the near lane, clear of both possible door crossings (garage at x=1, lobby at x=3)
  const yb = l.streetTop + PAVE * c + 0.48 * c;
  p.cars.push({ x: l.x0 - 0.25 * c, y: yb, dir: 1, fill: '#8DB4E2' });
  p.cars.push({ x: l.x0 + 4.75 * c, y: yb, dir: -1, fill: '#F2A9A2' });
}

function addTree(p: Painter, x: number, y: number, r: number, shrub: boolean, tone: number): void {
  const fill = TREE_FILLS[tone % TREE_FILLS.length];
  p.trees.push({ x, y, r, shrub, fill, light: P.mix(fill, '#FFFFFF', 0.32) });
}

/** The ground: through the offscreen layer when there is one (rebuilt when the layout, door or scale changes). */
function paintGround(p: Painter, l: Layout, doorX: number): void {
  const g = p.groundCtx;
  const cv = p.ground;
  if (!g || !cv) {
    drawGround(p, p.ctx, l, doorX);
    return;
  }
  if (p.groundFor !== l || p.groundDoorX !== doorX || p.groundScaleX !== p.scaleX || p.groundScaleY !== p.scaleY) {
    const bw = Math.max(1, Math.round(l.width * p.scaleX));
    const bh = Math.max(1, Math.round(l.height * p.scaleY));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    g.setTransform(p.scaleX, 0, 0, p.scaleY, 0, 0);
    g.clearRect(0, 0, l.width, l.height);
    drawGround(p, g, l, doorX);
    p.groundFor = l;
    p.groundDoorX = doorX;
    p.groundScaleX = p.scaleX;
    p.groundScaleY = p.scaleY;
  }
  p.ctx.drawImage(cv, 0, 0, l.width, l.height);
}

function drawGround(p: Painter, ctx: Ctx, l: Layout, doorX: number): void {
  paintBackground(p, ctx, l);
  paintStreet(p, ctx, l, doorX);
  for (let f = 0; f < l.floors; f++) paintSlab(p, ctx, l, f as 0 | 1);
  if (l.stair) paintStairs(p, ctx, l);
  paintTrees(ctx, p.trees);
  paintCars(ctx, l.cell, p.cars);
}

function paintBackground(p: Painter, ctx: Ctx, l: Layout): void {
  if (p.gradFor !== l || p.gradCtx !== ctx || !p.grass || !p.road) {
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, l.height));
    g.addColorStop(0, P.GRASS_LIGHT);
    g.addColorStop(0.55, P.GRASS);
    g.addColorStop(1, P.GRASS_DARK);
    const r = ctx.createLinearGradient(0, l.streetTop, 0, l.streetTop + Math.max(1, l.streetH));
    r.addColorStop(0, ROAD_NEAR);
    r.addColorStop(1, ROAD_FAR);
    p.grass = g;
    p.road = r;
    p.gradFor = l;
    p.gradCtx = ctx;
  }
  ctx.fillStyle = p.grass;
  ctx.fillRect(0, 0, l.width, l.height);
  for (let i = 0; i < p.blobs.length; i++) {
    const b = p.blobs[i];
    ellipse(ctx, b.x, b.y, b.rx, b.ry, 'rgba(60,125,50,0.08)');
  }
}

function paintStreet(p: Painter, ctx: Ctx, l: Layout, doorX: number): void {
  const c = l.cell;
  const W = l.width;
  const sy = l.streetTop;
  const pave = PAVE * c;
  const roadTop = sy + pave;
  const roadH = l.streetH - pave;
  // pavement with slab joints and a lighter stripe at the door
  ctx.fillStyle = P.PAVEMENT;
  ctx.fillRect(0, sy, W, pave);
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const slab = c * 0.75;
  for (let x = l.x0 % slab; x < W; x += slab) {
    ctx.moveTo(x, sy);
    ctx.lineTo(x, sy + pave);
  }
  ctx.stroke();
  ctx.fillStyle = P.PAVEMENT_LIGHT;
  ctx.fillRect(doorX - 0.22 * c, sy, 0.44 * c, pave);
  // kerb: a lit top edge, a dark base
  const kerbH = Math.max(2, c * 0.08);
  ctx.fillStyle = P.KERB;
  ctx.fillRect(0, roadTop - kerbH, W, kerbH);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillRect(0, roadTop - kerbH, W, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(0, roadTop - 1, W, 1);
  // road, darker towards the far edge
  ctx.fillStyle = p.road ?? P.STREET;
  ctx.fillRect(0, roadTop, W, roadH);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, roadTop + roadH - c * 0.06, W, c * 0.06);
  // lane dashes
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(1, c * 0.035);
  ctx.setLineDash(p.roadDash);
  ctx.beginPath();
  const ry = roadTop + roadH * 0.55;
  ctx.moveTo(0, ry);
  ctx.lineTo(W, ry);
  ctx.stroke();
  ctx.setLineDash(p.noDash);
  // zebra crossing in front of the door
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const stripe = 0.1 * c;
  const gap = 0.08 * c;
  const zx0 = doorX - (ZEBRA_N * stripe + (ZEBRA_N - 1) * gap) / 2;
  for (let i = 0; i < ZEBRA_N; i++) ctx.fillRect(zx0 + i * (stripe + gap), roadTop + 0.08 * c, stripe, roadH - 0.16 * c);
}

/** One floor's lot: warm pavement with a two-tone tile pattern, a soft inset shadow and a drop shadow. */
function paintSlab(p: Painter, ctx: Ctx, l: Layout, floor: 0 | 1): void {
  const c = l.cell;
  const r = rectOf(l, floor, 0, 0, l.cols, l.rowsPerFloor, p.tmp);
  const rad = c * 0.22;
  shadowRR(ctx, r.x, r.y, r.w, r.h, rad, P.LOT, c * 0.5, c * 0.14, 'rgba(30,40,70,0.26)');
  ctx.save();
  rr(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.clip();
  ctx.fillStyle = P.LOT_LIGHT;
  for (let j = 0; j < l.rowsPerFloor; j++) {
    for (let i = j & 1; i < l.cols; i += 2) ctx.fillRect(r.x + i * c, r.y + j * c, c, c);
  }
  // inset shadow: a stroke entirely outside the clip whose blurred shadow bleeds inwards
  ctx.shadowColor = 'rgba(30,35,60,0.36)';
  ctx.shadowBlur = c * 0.55;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  strokeRR(ctx, r.x - c * 0.5 - 1, r.y - c * 0.5 - 1, r.w + c + 2, r.h + c + 2, rad + c * 0.5, '#000000', c);
  clearShadow(ctx);
  ctx.restore();
  strokeRR(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad, 'rgba(70,55,40,0.2)', 1);
}

function paintStairs(p: Painter, ctx: Ctx, l: Layout): void {
  const s = l.stair;
  if (!s) return;
  const c = l.cell;
  shadowRR(ctx, s.x, s.y - c * 0.06, s.w, s.h + c * 0.12, c * 0.08, '#E8E4DD', c * 0.2, c * 0.05, 'rgba(30,40,70,0.2)');
  const stepH = s.h / STAIR_STEPS;
  for (let i = 0; i < STAIR_STEPS; i++) {
    ctx.fillStyle = p.stairShades[i];
    ctx.fillRect(s.x + c * 0.1, s.y + i * stepH, s.w - c * 0.2, Math.max(1, stepH - 1));
  }
  const lw = Math.max(1, c * 0.04);
  line(ctx, s.x + c * 0.06, s.y - c * 0.04, s.x + c * 0.06, s.y + s.h + c * 0.04, '#8E8A82', lw);
  line(ctx, s.x + s.w - c * 0.06, s.y - c * 0.04, s.x + s.w - c * 0.06, s.y + s.h + c * 0.04, '#8E8A82', lw);
}

function paintTrees(ctx: Ctx, trees: Tree[]): void {
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    const r = t.r;
    if (t.shrub) {
      ellipse(ctx, t.x + r * 0.15, t.y + r * 0.5, r * 1.2, r * 0.35, 'rgba(30,60,30,0.16)');
      ellipse(ctx, t.x, t.y, r * 1.15, r * 0.8, t.fill);
      ellipse(ctx, t.x - r * 0.3, t.y - r * 0.22, r * 0.5, r * 0.3, t.light);
    } else {
      ellipse(ctx, t.x + r * 0.3, t.y + r * 1.15, r * 1.1, r * 0.35, 'rgba(30,60,30,0.18)');
      fillRR(ctx, t.x - r * 0.12, t.y + r * 0.35, r * 0.24, r * 0.85, r * 0.08, TRUNK);
      circle(ctx, t.x - r * 0.5, t.y + r * 0.2, r * 0.62, t.fill);
      circle(ctx, t.x + r * 0.5, t.y + r * 0.2, r * 0.62, t.fill);
      circle(ctx, t.x, t.y - r * 0.1, r * 0.85, t.fill);
      circle(ctx, t.x - r * 0.25, t.y - r * 0.4, r * 0.35, t.light);
    }
  }
}

function paintCars(ctx: Ctx, c: number, cars: Car[]): void {
  const bw = 1.1 * c;
  const bh = 0.26 * c;
  const cw = 0.56 * c;
  const ch = 0.16 * c;
  for (let i = 0; i < cars.length; i++) {
    const k = cars[i];
    const yb = k.y;
    const bodyY = yb - 0.07 * c - bh;
    const cabX = k.x - k.dir * 0.06 * c - cw / 2;
    const cabY = bodyY - ch + 0.03 * c;
    ellipse(ctx, k.x, yb - 0.01 * c, bw * 0.55, 0.06 * c, 'rgba(20,20,40,0.18)');
    fillStrokeRR(ctx, cabX, cabY, cw, ch + 0.06 * c, 0.07 * c, k.fill, OUTLINE, 1);
    fillRR(ctx, cabX + 0.04 * c, cabY + 0.03 * c, cw - 0.08 * c, ch - 0.05 * c, 0.04 * c, '#DCEFFB');
    ctx.fillStyle = k.fill;
    ctx.fillRect(cabX + cw / 2 - 0.015 * c, cabY + 0.03 * c, 0.03 * c, ch - 0.05 * c);
    fillStrokeRR(ctx, k.x - bw / 2, bodyY, bw, bh, 0.07 * c, k.fill, OUTLINE, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(k.x - bw / 2 + 0.06 * c, bodyY + 0.03 * c, bw - 0.12 * c, 0.05 * c);
    ctx.fillStyle = '#FFF2B0';
    ctx.fillRect(k.x + k.dir * (bw / 2 - 0.06 * c) - 0.02 * c, bodyY + 0.07 * c, 0.04 * c, 0.06 * c);
    ctx.fillStyle = '#E8625A';
    ctx.fillRect(k.x - k.dir * (bw / 2 - 0.06 * c) - 0.02 * c, bodyY + 0.07 * c, 0.04 * c, 0.06 * c);
    circleO(ctx, k.x - 0.34 * c, yb - 0.075 * c, 0.078 * c, '#2F333D', OUTLINE, 1);
    circle(ctx, k.x - 0.34 * c, yb - 0.075 * c, 0.032 * c, '#A3A8B3');
    circleO(ctx, k.x + 0.34 * c, yb - 0.075 * c, 0.078 * c, '#2F333D', OUTLINE, 1);
    circle(ctx, k.x + 0.34 * c, yb - 0.075 * c, 0.032 * c, '#A3A8B3');
  }
}

/** The street door: a glass double door on the hall's bottom edge, with a mat. */
function paintDoor(p: Painter, l: Layout, scene: Scene): void {
  const ctx = p.ctx;
  const c = l.cell;
  const d = scene.anchors.door;
  const w = 0.44 * c;
  const h = 0.16 * c;
  fillRR(ctx, d.x - w / 2, d.y - 0.1 * c, w, h, c * 0.03, '#4D5262');
  const paneW = w / 2 - 0.035 * c;
  const paneH = h - 0.05 * c;
  fillRR(ctx, d.x - w / 2 + 0.025 * c, d.y - 0.075 * c, paneW, paneH, c * 0.02, '#A9D1EF');
  fillRR(ctx, d.x + 0.01 * c, d.y - 0.075 * c, paneW, paneH, c * 0.02, '#A9D1EF');
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(d.x - w / 2 + 0.04 * c, d.y - 0.065 * c, paneW * 0.35, paneH * 0.4);
  ctx.fillRect(d.x + 0.025 * c, d.y - 0.065 * c, paneW * 0.35, paneH * 0.4);
  fillRR(ctx, d.x - 0.16 * c, d.y + 0.05 * c, 0.32 * c, 0.09 * c, c * 0.02, '#9C7A57');
}

// ---------------------------------------------------------------- rooms

function paintRoom(p: Painter, l: Layout, scene: Scene, v: RoomView, crowd: Crowd, info: FrameInfo): void {
  const ctx = p.ctx;
  const c = l.cell;
  const r = v.rect;
  const k = v.room.kind;
  const rad = c * 0.16;
  const sideW = SIDE_WALL * c;
  const backH = BACK_WALL * c;

  // DESIGN 3: a rounded pastel room with short extruded walls and a soft drop shadow
  shadowRR(ctx, r.x, r.y, r.w, r.h, rad, P.ROOM_FLOOR[k], c * 0.45, c * 0.16, 'rgba(25,30,60,0.22)');
  ctx.save();
  rr(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.clip();
  // faint planks under the pastel tint (DESIGN 3: wood floors)
  ctx.strokeStyle = 'rgba(90,60,30,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = r.y + backH + c * 0.33; y < r.y + r.h - c * 0.05; y += c * 0.33) {
    const yy = Math.round(y) + 0.5;
    ctx.moveTo(r.x + sideW, yy);
    ctx.lineTo(r.x + r.w - sideW, yy);
  }
  ctx.stroke();
  // side walls: thin darker strips with a hairline on their inner edge
  ctx.fillStyle = P.ROOM_SIDE[k];
  ctx.fillRect(r.x, r.y, sideW, r.h);
  ctx.fillRect(r.x + r.w - sideW, r.y, sideW, r.h);
  ctx.fillStyle = 'rgba(20,20,40,0.12)';
  ctx.fillRect(r.x + sideW - 1, r.y, 1, r.h);
  ctx.fillRect(r.x + r.w - sideW, r.y, 1, r.h);
  // back wall: a lighter tint, a thin darker top edge, a shadow thrown onto the floor
  ctx.fillStyle = P.ROOM_BACK[k];
  ctx.fillRect(r.x, r.y, r.w, backH);
  if (k === 'garage') paintRollupDoor(ctx, c, r, sideW, backH);
  ctx.fillStyle = P.ROOM_TOP[k];
  ctx.fillRect(r.x, r.y, r.w, Math.max(1.5, c * 0.045));
  ctx.fillStyle = 'rgba(20,20,40,0.1)';
  ctx.fillRect(r.x, r.y + backH, r.w, c * 0.05);
  ctx.fillStyle = 'rgba(20,20,40,0.05)';
  ctx.fillRect(r.x, r.y + backH + c * 0.05, r.w, c * 0.05);
  ctx.restore();
  strokeRR(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad, P.ROOM_EDGE[k], 1);

  paintPlant(ctx, c, v.plant.x, v.plant.y);
  switch (k) {
    case 'product': paintRacks(ctx, c, v, scene, info.time); break;
    case 'sales': paintEasel(ctx, c, v); break;
    case 'support': paintHeadsetStand(ctx, c, v); break;
    case 'marketing': paintPoster(ctx, c, v); break;
    case 'finance': paintSafe(ctx, c, v); break;
    case 'rnd': paintLabBench(ctx, c, v); break;
    case 'lobby': paintLobby(p, c, scene, info); break;
    case 'garage': paintGarage(ctx, c, v, scene); break;
    case 'demo': paintDemo(ctx, c, v, backH); break;
  }

  // chairs, seated people and desks, row by row so lower rows overlap upper ones
  const n = Math.max(v.slots.length, v.seats.length);
  const laptop = k === 'garage';
  for (let i = 0; i < n; i++) {
    const seat = i < v.seats.length ? v.seats[i] : null;
    if (i < v.deskCount) paintChair(ctx, c, v.slots[i].x - 0.06 * c, v.slots[i].y + 0.06 * c);
    if (seat && !walkingIn(crowd, seat.personId)) paintSeat(ctx, c, seat, info.time);
    if (i < v.deskCount) paintDesk(ctx, c, v.slots[i].x, v.slots[i].y, laptop);
  }
  paintLabel(p, c, v, k);
}

/** A hired person is still walking to the desk: the seat stays empty until they arrive. */
function walkingIn(crowd: Crowd, personId: string): boolean {
  for (let i = 0; i < crowd.walkers.length; i++) {
    const w = crowd.walkers[i];
    if (w.active && w.kind === 'hire' && w.personId === personId) return true;
  }
  return false;
}

function paintRollupDoor(ctx: Ctx, c: number, r: Rect, sideW: number, backH: number): void {
  const slat = Math.max(2, c * 0.07);
  const x = r.x + sideW;
  const w = r.w - 2 * sideW;
  for (let y = r.y + c * 0.03, i = 0; y < r.y + backH - slat; y += slat, i++) {
    ctx.fillStyle = i % 2 === 0 ? '#D8D1C7' : '#CBC3B8';
    ctx.fillRect(x, y, w, slat - 1);
  }
  fillRR(ctx, r.x + r.w / 2 - c * 0.08, r.y + backH - c * 0.1, c * 0.16, c * 0.05, c * 0.02, '#6E6760');
}

function paintPlant(ctx: Ctx, c: number, x: number, y: number): void {
  fillStrokeRR(ctx, x - 0.07 * c, y - 0.02 * c, 0.14 * c, 0.12 * c, c * 0.03, '#B9785A', OUTLINE, 1);
  circle(ctx, x, y - 0.1 * c, 0.08 * c, '#6FBF73');
  circle(ctx, x - 0.07 * c, y - 0.05 * c, 0.065 * c, '#5BAF63');
  circle(ctx, x + 0.07 * c, y - 0.05 * c, 0.065 * c, '#7CCB7F');
}

/** top-left corner of a room's prop spot: against the back wall, left of the desks */
function propX(c: number, v: RoomView): number {
  return v.rect.x + SIDE_WALL * c + 0.06 * c;
}

function propY(c: number, v: RoomView): number {
  return v.rect.y + BACK_WALL * c;
}

/** Product: server racks (one per owned server, up to three) with three blinking LEDs each. */
function paintRacks(ctx: Ctx, c: number, v: RoomView, scene: Scene, time: number): void {
  const n = Math.max(1, Math.min(3, scene.servers));
  const x0 = propX(c, v);
  const y0 = propY(c, v) - 0.06 * c;
  const rw = 0.22 * c;
  const rh = 0.42 * c;
  for (let i = 0; i < n; i++) {
    const rx = x0 + i * 0.26 * c;
    fillRR(ctx, rx + 0.012 * c, y0 + 0.03 * c, rw, rh, c * 0.03, 'rgba(20,20,40,0.18)');
    fillStrokeRR(ctx, rx, y0, rw, rh, c * 0.03, '#3E4556', OUTLINE, 1);
    const lit = i < scene.servers;
    for (let j = 0; j < 3; j++) {
      const ly = y0 + 0.08 * c + j * 0.12 * c;
      ctx.fillStyle = '#5B6478';
      ctx.fillRect(rx + 0.1 * c, ly - 0.014 * c, rw - 0.13 * c, 0.028 * c);
      const blink = (Math.floor(time * (2.5 + j * 0.9) + i * 1.7) & 1) === 0;
      const color = !lit ? '#555C6B' : scene.serversShort > 0 && j === 0 ? (blink ? '#FF6B6B' : '#8A2E2E') : blink ? '#5EF08B' : '#2E8B57';
      circle(ctx, rx + 0.055 * c, ly, 0.022 * c, color);
    }
  }
}

/** Sales: a flipchart easel with a rising line. */
function paintEasel(ctx: Ctx, c: number, v: RoomView): void {
  const x = propX(c, v);
  const y = propY(c, v) - 0.08 * c;
  const w = 0.36 * c;
  const h = 0.26 * c;
  const lw = Math.max(1, c * 0.025);
  line(ctx, x + 0.06 * c, y + h, x + 0.02 * c, y + h + 0.16 * c, TRUNK, lw);
  line(ctx, x + w - 0.06 * c, y + h, x + w - 0.02 * c, y + h + 0.16 * c, TRUNK, lw);
  fillRR(ctx, x + 0.012 * c, y + 0.03 * c, w, h, c * 0.02, 'rgba(20,20,40,0.16)');
  fillStrokeRR(ctx, x, y, w, h, c * 0.02, '#FFFFFF', OUTLINE, 1);
  ctx.strokeStyle = P.DEPT.sales;
  ctx.lineWidth = Math.max(1.2, c * 0.03);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + 0.05 * c, y + h - 0.06 * c);
  ctx.lineTo(x + 0.13 * c, y + h - 0.13 * c);
  ctx.lineTo(x + 0.2 * c, y + h - 0.1 * c);
  ctx.lineTo(x + w - 0.05 * c, y + 0.05 * c);
  ctx.stroke();
  circle(ctx, x + w - 0.05 * c, y + 0.05 * c, 0.028 * c, P.DEPT.sales);
}

/** Support: a headset on a stand. */
function paintHeadsetStand(ctx: Ctx, c: number, v: RoomView): void {
  const x = propX(c, v) + 0.15 * c;
  const y = propY(c, v) + 0.38 * c;
  ellipse(ctx, x, y, 0.1 * c, 0.035 * c, '#6B7280');
  line(ctx, x, y, x, y - 0.3 * c, '#6B7280', Math.max(1.5, c * 0.03));
  ctx.strokeStyle = P.DEPT.support;
  ctx.lineWidth = Math.max(2, c * 0.045);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(x, y - 0.3 * c, 0.1 * c, Math.PI, Math.PI * 2);
  ctx.stroke();
  fillStrokeRR(ctx, x - 0.145 * c, y - 0.32 * c, 0.07 * c, 0.1 * c, c * 0.02, P.DEPT.support, OUTLINE, 1);
  fillStrokeRR(ctx, x + 0.075 * c, y - 0.32 * c, 0.07 * c, 0.1 * c, c * 0.02, P.DEPT.support, OUTLINE, 1);
  line(ctx, x + 0.11 * c, y - 0.22 * c, x + 0.03 * c, y - 0.17 * c, P.DEPT.support, Math.max(1, c * 0.02));
}

/** Marketing: a standing poster board with a megaphone. */
function paintPoster(ctx: Ctx, c: number, v: RoomView): void {
  const x = propX(c, v);
  const y = propY(c, v) - 0.08 * c;
  const w = 0.32 * c;
  const h = 0.34 * c;
  const lw = Math.max(1, c * 0.025);
  line(ctx, x + 0.06 * c, y + h, x + 0.03 * c, y + h + 0.12 * c, TRUNK, lw);
  line(ctx, x + w - 0.06 * c, y + h, x + w - 0.03 * c, y + h + 0.12 * c, TRUNK, lw);
  fillRR(ctx, x + 0.012 * c, y + 0.03 * c, w, h, c * 0.02, 'rgba(20,20,40,0.16)');
  fillStrokeRR(ctx, x, y, w, h, c * 0.02, P.DEPT.marketing, OUTLINE, 1);
  drawGlyph(ctx, 'marketing', x + w / 2, y + h * 0.4, 0.17 * c, '#FFFFFF');
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(x + 0.06 * c, y + h - 0.1 * c, w - 0.12 * c, 0.025 * c);
  ctx.fillRect(x + 0.09 * c, y + h - 0.055 * c, w - 0.18 * c, 0.025 * c);
}

/** Finance: a safe with a dial. */
function paintSafe(ctx: Ctx, c: number, v: RoomView): void {
  const x = propX(c, v);
  const y = propY(c, v) - 0.04 * c;
  const w = 0.3 * c;
  const h = 0.34 * c;
  fillRR(ctx, x + 0.015 * c, y + 0.03 * c, w, h, c * 0.03, 'rgba(20,20,40,0.18)');
  fillStrokeRR(ctx, x, y, w, h, c * 0.03, '#4A5160', OUTLINE, 1);
  fillRR(ctx, x + 0.03 * c, y + 0.03 * c, w - 0.06 * c, h - 0.06 * c, c * 0.02, '#5B6373');
  ring(ctx, x + w * 0.42, y + h * 0.5, 0.055 * c, '#E8EBF0', Math.max(1, c * 0.02));
  circle(ctx, x + w * 0.42, y + h * 0.5, 0.02 * c, '#E8EBF0');
  line(ctx, x + w * 0.74, y + h * 0.32, x + w * 0.74, y + h * 0.68, '#E8EBF0', Math.max(1.2, c * 0.03));
  ctx.fillStyle = '#3A3F4C';
  ctx.fillRect(x + 0.03 * c, y + h, 0.05 * c, 0.03 * c);
  ctx.fillRect(x + w - 0.08 * c, y + h, 0.05 * c, 0.03 * c);
}

/** R&D: a lab bench with a flask and a beaker. */
function paintLabBench(ctx: Ctx, c: number, v: RoomView): void {
  const x = propX(c, v);
  const y = propY(c, v) + 0.2 * c;
  const w = 0.4 * c;
  ctx.fillStyle = '#B9AE9E';
  ctx.fillRect(x + 0.03 * c, y + 0.08 * c, 0.03 * c, 0.14 * c);
  ctx.fillRect(x + w - 0.06 * c, y + 0.08 * c, 0.03 * c, 0.14 * c);
  fillRR(ctx, x + 0.012 * c, y + 0.03 * c, w, 0.09 * c, c * 0.02, 'rgba(20,20,40,0.16)');
  fillStrokeRR(ctx, x, y, w, 0.09 * c, c * 0.02, '#D9D0C2', OUTLINE, 1);
  drawGlyph(ctx, 'rnd', x + 0.12 * c, y - 0.11 * c, 0.2 * c, P.DEPT.rnd);
  fillStrokeRR(ctx, x + 0.25 * c, y - 0.14 * c, 0.1 * c, 0.14 * c, c * 0.015, 'rgba(79,185,201,0.55)', OUTLINE, 1);
}

function paintCoffee(ctx: Ctx, c: number, x: number, y: number): void {
  fillStrokeRR(ctx, x - 0.11 * c, y - 0.16 * c, 0.22 * c, 0.3 * c, c * 0.03, '#3F3A44', OUTLINE, 1);
  fillRR(ctx, x - 0.08 * c, y - 0.12 * c, 0.16 * c, 0.1 * c, c * 0.02, '#8C7B6B');
  fillRR(ctx, x - 0.04 * c, y + 0.02 * c, 0.08 * c, 0.07 * c, c * 0.015, '#FFFFFF');
  circle(ctx, x + 0.06 * c, y - 0.07 * c, 0.012 * c, '#FF7A59');
}

function paintLobby(p: Painter, c: number, scene: Scene, info: FrameInfo): void {
  const ctx = p.ctx;
  const lb = scene.lobby;
  if (!lb) return;
  const rec = lb.reception;
  shadowRR(ctx, rec.x, rec.y, rec.w, rec.h, c * 0.05, '#E9C6D5', c * 0.1, c * 0.03, 'rgba(30,30,60,0.16)');
  fillRR(ctx, rec.x, rec.y, rec.w, rec.h * 0.45, c * 0.05, 'rgba(255,255,255,0.3)');
  strokeRR(ctx, rec.x + 0.5, rec.y + 0.5, rec.w - 1, rec.h - 1, c * 0.05, OUTLINE, 1);
  circle(ctx, rec.x + 0.14 * c, rec.y + 0.02 * c, 0.045 * c, P.GOLD);
  ctx.fillStyle = '#8A6A00';
  ctx.fillRect(rec.x + 0.08 * c, rec.y + 0.05 * c, 0.12 * c, 0.02 * c);
  fillRR(ctx, rec.x + rec.w - 0.3 * c, rec.y - 0.12 * c, 0.18 * c, 0.12 * c, c * 0.02, SCREEN_DARK);
  fillRR(ctx, rec.x + rec.w - 0.285 * c, rec.y - 0.105 * c, 0.15 * c, 0.09 * c, c * 0.01, SCREEN_LIT);

  const tr = lb.tray;
  fillStrokeRR(ctx, tr.x, tr.y, tr.w, tr.h, c * 0.03, '#AEB5C2', OUTLINE, 1);
  fillRR(ctx, tr.x + 0.02 * c, tr.y + 0.02 * c, tr.w - 0.04 * c, tr.h - 0.04 * c, c * 0.02, '#C9CFD9');
  const papers = Math.min(MAX_PAPERS, Math.max(0, info.openInvoices));
  if (papers > 0) {
    const px = tr.x + 0.05 * c;
    const pw = tr.w - 0.1 * c;
    const ph = 0.026 * c;
    ctx.fillStyle = '#FFFFFF';
    for (let i = 0; i < papers; i++) ctx.fillRect(px, tr.y + tr.h - 0.06 * c - i * 0.028 * c, pw, ph);
    ctx.fillStyle = 'rgba(40,50,80,0.12)';
    for (let i = 0; i < papers; i++) ctx.fillRect(px, tr.y + tr.h - 0.06 * c - i * 0.028 * c, pw, 1);
  }

  if (scene.coffee) paintCoffee(ctx, c, lb.coffee.x, lb.coffee.y);
}

/**
 * "Owed to you $X": a small white sign with a dark border above the invoice
 * tray, pointing at it, drawn after every room so nothing covers it and
 * clamped to the lot when the text is wider than the lobby.
 */
function paintSign(p: Painter, l: Layout, scene: Scene, info: FrameInfo): void {
  const ctx = p.ctx;
  const lb = scene.lobby;
  if (!lb) return;
  const c = l.cell;
  ctx.font = p.fontSign;
  if (p.signAr !== info.ar || p.signW < 0) {
    p.signText = 'Owed to you ' + formatMoney(info.ar);
    p.signAr = info.ar;
    p.signW = ctx.measureText(p.signText).width;
  }
  const sh = Math.max(0.28 * c, p.signFontPx * 1.8);
  const sw = p.signW + Math.max(0.3 * c, 10);
  let sx = lb.sign.x - sw;
  sx = Math.max(l.x0 + 2, Math.min(sx, l.x0 + l.lotW - sw - 2));
  const sy = lb.sign.y - sh / 2;
  const tipX = clamp(scene.anchors.tray.x, sx + 0.14 * c, sx + sw - 0.14 * c);
  const border = Math.max(1.2, c * 0.03);
  // the pointer at the tray, then the sign over its top edge
  ctx.beginPath();
  ctx.moveTo(tipX - 0.07 * c, sy + sh - 1);
  ctx.lineTo(tipX, sy + sh + 0.08 * c);
  ctx.lineTo(tipX + 0.07 * c, sy + sh - 1);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = P.INK;
  ctx.lineWidth = border;
  ctx.lineJoin = 'round';
  ctx.stroke();
  shadowRR(ctx, sx, sy, sw, sh, c * 0.05, '#FFFFFF', c * 0.12, c * 0.03, 'rgba(30,30,60,0.2)');
  strokeRR(ctx, sx, sy, sw, sh, c * 0.05, P.INK, border);
  ctx.fillStyle = P.INK;
  ctx.font = p.fontSign;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.signText, sx + sw / 2, lb.sign.y + 0.5);
}

function paintGarage(ctx: Ctx, c: number, v: RoomView, scene: Scene): void {
  const r = v.rect;
  const bx = r.x + 0.2 * c;
  const by = r.y + r.h - 0.2 * c;
  fillStrokeRR(ctx, bx, by - 0.32 * c, 0.32 * c, 0.32 * c, c * 0.02, '#D7B48A', OUTLINE, 1);
  fillStrokeRR(ctx, bx + 0.36 * c, by - 0.26 * c, 0.26 * c, 0.26 * c, c * 0.02, '#CFA87E', OUTLINE, 1);
  fillStrokeRR(ctx, bx + 0.04 * c, by - 0.58 * c, 0.24 * c, 0.24 * c, c * 0.02, '#E0BF98', OUTLINE, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillRect(bx + 0.14 * c, by - 0.32 * c, 0.04 * c, 0.32 * c);
  ctx.fillRect(bx + 0.47 * c, by - 0.26 * c, 0.04 * c, 0.26 * c);

  const wx = r.x + r.w - 0.66 * c;
  const wy = r.y + r.h - 0.32 * c;
  const lw = Math.max(1, c * 0.03);
  ring(ctx, wx, wy, 0.13 * c, '#4A4F5A', lw);
  ring(ctx, wx + 0.42 * c, wy, 0.13 * c, '#4A4F5A', lw);
  ctx.strokeStyle = '#E25C5C';
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(wx, wy);
  ctx.lineTo(wx + 0.2 * c, wy - 0.2 * c);
  ctx.lineTo(wx + 0.42 * c, wy);
  ctx.lineTo(wx + 0.2 * c, wy);
  ctx.closePath();
  ctx.moveTo(wx + 0.2 * c, wy - 0.2 * c);
  ctx.lineTo(wx + 0.36 * c, wy - 0.22 * c);
  ctx.stroke();
  fillRR(ctx, wx + 0.12 * c, wy - 0.26 * c, 0.14 * c, 0.05 * c, c * 0.02, '#2F3340');
  if (scene.coffee && !scene.hasLobby) paintCoffee(ctx, c, r.x + r.w / 2, r.y + r.h - 0.62 * c);
}

function paintDemo(ctx: Ctx, c: number, v: RoomView, backH: number): void {
  const r = v.rect;
  const cx = r.x + r.w / 2;
  const sy = r.y + backH + 0.08 * c;
  shadowRR(ctx, cx - 0.5 * c, sy, 1.0 * c, 0.42 * c, c * 0.04, SCREEN_DARK, c * 0.1, c * 0.03, 'rgba(30,30,60,0.2)');
  fillRR(ctx, cx - 0.46 * c, sy + 0.04 * c, 0.92 * c, 0.34 * c, c * 0.03, '#9EC3F5');
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.moveTo(cx - 0.08 * c, sy + 0.11 * c);
  ctx.lineTo(cx + 0.12 * c, sy + 0.21 * c);
  ctx.lineTo(cx - 0.08 * c, sy + 0.31 * c);
  ctx.closePath();
  ctx.fill();
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      circleO(ctx, cx - 0.35 * c + col * 0.35 * c, r.y + 1.15 * c + row * 0.32 * c, 0.075 * c, '#7D8FB3', OUTLINE, 1);
    }
  }
}

/** An office chair back, drawn behind the figure so it peeks out beside the shoulders. */
function paintChair(ctx: Ctx, c: number, x: number, feet: number): void {
  fillStrokeRR(ctx, x - 0.16 * c, feet - 0.37 * c, 0.32 * c, 0.25 * c, c * 0.09, CHAIR, OUTLINE, 1);
  fillRR(ctx, x - 0.12 * c, feet - 0.34 * c, 0.24 * c, 0.15 * c, c * 0.06, CHAIR_PAD);
}

/** A rounded desk with a slim monitor (or an open laptop in the garage). */
function paintDesk(ctx: Ctx, c: number, x: number, y: number, laptop: boolean): void {
  const w = 0.56 * c;
  const h = 0.22 * c;
  fillRR(ctx, x - w / 2 + c * 0.012, y - h / 2 + c * 0.04, w, h, c * 0.06, 'rgba(30,30,60,0.16)');
  fillStrokeRR(ctx, x - w / 2, y - h / 2, w, h, c * 0.06, DESK_TOP, 'rgba(90,60,30,0.3)', 1);
  fillRR(ctx, x - w / 2 + 1, y - h / 2 + 1, w - 2, h * 0.42, c * 0.06, 'rgba(255,255,255,0.28)');
  if (laptop) {
    fillRR(ctx, x - 0.02 * c, y - 0.08 * c, 0.2 * c, 0.035 * c, c * 0.01, '#6B7280');
    fillRR(ctx, x - 0.01 * c, y - 0.21 * c, 0.18 * c, 0.135 * c, c * 0.015, SCREEN_DARK);
    fillRR(ctx, x + 0.005 * c, y - 0.195 * c, 0.15 * c, 0.1 * c, c * 0.01, SCREEN_LIT);
    return;
  }
  const mw = 0.2 * c;
  const mh = 0.13 * c;
  const mx = x + 0.1 * c - mw / 2;
  const my = y - h / 2 - mh + c * 0.03;
  ctx.fillStyle = '#596070';
  ctx.fillRect(mx + mw / 2 - c * 0.02, my + mh - c * 0.01, c * 0.04, c * 0.04);
  ctx.fillRect(mx + mw / 2 - c * 0.05, my + mh + c * 0.025, c * 0.1, c * 0.012);
  fillRR(ctx, mx, my, mw, mh, c * 0.02, SCREEN_DARK);
  fillRR(ctx, mx + c * 0.015, my + c * 0.015, mw - c * 0.03, mh - c * 0.03, c * 0.01, SCREEN_LIT);
}

function paintSeat(ctx: Ctx, c: number, s: SeatInfo, time: number): void {
  const bob = Math.sin(time * 2.2 + s.phase) * 0.012 * c;
  drawFigure(ctx, s.x, s.y, SEAT_H * c, P.DEPT[s.role], P.SKIN[s.skin], P.HAIR[s.hair], bob, 0, true, 1, 1);
  if (s.founder) circleO(ctx, s.x + 0.08 * c, s.y - 0.2 * c + bob, 0.035 * c, P.GOLD, 'rgba(90,60,0,0.6)', 1);
}

/** The room's name on a glassy pill with its glyph, hung on the back wall. */
function paintLabel(p: Painter, c: number, v: RoomView, k: RoomView['room']['kind']): void {
  const ctx = p.ctx;
  ctx.font = p.fontLabel;
  if (v.labelW < 0) v.labelW = ctx.measureText(v.label).width;
  const gs = c * 0.2;
  const padX = c * 0.1;
  const gap = c * 0.06;
  const h = c * 0.28;
  let w = padX * 2 + gs + gap + v.labelW;
  const withText = w <= v.rect.w - c * 0.12;
  if (!withText) w = h;
  const x = v.rect.x + v.rect.w / 2 - w / 2;
  const y = v.rect.y + c * 0.035;
  shadowRR(ctx, x, y, w, h, h / 2, 'rgba(255,255,255,0.74)', c * 0.08, c * 0.02, 'rgba(30,30,60,0.18)');
  fillRR(ctx, x + 1, y + 1, w - 2, h * 0.5, h / 2, 'rgba(255,255,255,0.45)');
  strokeRR(ctx, x + 0.5, y + 0.5, w - 1, h - 1, h / 2, 'rgba(255,255,255,0.9)', 1);
  if (withText) {
    drawGlyph(ctx, k, x + padX + gs / 2, y + h / 2, gs, P.ROOM_BASE[k]);
    ctx.fillStyle = P.INK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(v.label, x + padX + gs + gap, y + h / 2 + 0.5);
  } else {
    drawGlyph(ctx, k, x + w / 2, y + h / 2, gs, P.ROOM_BASE[k]);
  }
}

function paintSelection(p: Painter, l: Layout, scene: Scene, info: FrameInfo): void {
  const v = info.selectedRoomId ? scene.byId.get(info.selectedRoomId) : undefined;
  if (!v) return;
  const ctx = p.ctx;
  const c = l.cell;
  const r = v.rect;
  const rad = c * 0.16;
  const pulse = 0.65 + 0.35 * Math.sin(info.time * 4);
  ctx.shadowColor = 'rgba(255,255,255,0.95)';
  ctx.shadowBlur = c * 0.45 * pulse;
  strokeRR(ctx, r.x, r.y, r.w, r.h, rad, 'rgba(255,255,255,0.95)', Math.max(2, c * 0.05));
  clearShadow(ctx);
  strokeRR(ctx, r.x, r.y, r.w, r.h, rad, P.ROOM_BASE[v.room.kind], Math.max(1.5, c * 0.035));
}

// ---------------------------------------------------------------- crowd

function paintWalkers(p: Painter, l: Layout, crowd: Crowd): void {
  const ctx = p.ctx;
  const c = l.cell;
  const h = WALKER_H * c;
  for (let i = 0; i < crowd.walkers.length; i++) {
    const w: Walker = crowd.walkers[i];
    if (!w.active) continue;
    const walk = w.moving ? w.dist / (0.09 * c) : 0;
    const bob = w.moving ? -Math.abs(Math.sin(walk)) * 0.035 * c : Math.sin(w.age * 2.5 + w.phase) * 0.012 * c;
    let alpha = w.alpha;
    if (w.kind === 'churn' && w.age < 0.4) alpha *= w.age / 0.4;
    drawFigure(ctx, w.x, w.y, h, w.body, P.SKIN[w.skin], P.HAIR[w.hair], bob, walk, false, alpha, w.dir);
    if (w.kind === 'enterprise' || w.kind === 'waiting') {
      fillStrokeRR(ctx, w.x + w.dir * 0.17 * c - 0.07 * c, w.y - 0.24 * c + bob, 0.14 * c, 0.11 * c, c * 0.02, '#3B3F4A', OUTLINE, 1);
    }
    if (w.badge > 1) {
      ctx.font = p.fontBadge;
      if (w.badgeW < 0) w.badgeW = ctx.measureText(w.badgeText).width;
      const bw = w.badgeW + 0.14 * c;
      const bh = 0.2 * c;
      const bx = w.x - bw / 2;
      const by = w.y - h - 0.26 * c + bob;
      fillStrokeRR(ctx, bx, by, bw, bh, bh / 2, 'rgba(255,255,255,0.92)', OUTLINE, 1);
      ctx.fillStyle = P.INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(w.badgeText, w.x, by + bh / 2 + 0.5);
    }
  }
}

function paintEffects(p: Painter, l: Layout, crowd: Crowd): void {
  const ctx = p.ctx;
  const c = l.cell;
  for (let i = 0; i < crowd.effects.length; i++) {
    const e: Effect = crowd.effects[i];
    if (!e.active) continue;
    const pr = clamp(e.t / e.dur, 0, 1);
    switch (e.type) {
      case 'coin': paintCoin(p, c, e, pr); break;
      case 'slip': paintSlip(ctx, c, e, pr); break;
      case 'puff': paintPuff(ctx, c, e, pr); break;
      case 'confetti': paintConfetti(ctx, c, e, pr); break;
      case 'glow': {
        ctx.globalAlpha = Math.sin(pr * Math.PI) * 0.9;
        ctx.shadowColor = e.color;
        ctx.shadowBlur = c * 0.5;
        strokeRR(ctx, e.x, e.y, e.w, e.h, c * 0.16, e.color, Math.max(2, c * 0.06));
        clearShadow(ctx);
        ctx.globalAlpha = 1;
        break;
      }
      case 'flash': {
        // outage: a red translucent flash over the product room
        ctx.globalAlpha = Math.abs(Math.sin(pr * Math.PI * 3)) * (1 - pr * 0.5) * 0.45;
        fillRR(ctx, e.x, e.y, e.w, e.h, c * 0.16, '#F03E3E');
        ctx.globalAlpha = 1;
        break;
      }
      case 'sweep': {
        const bandW = e.w * 0.35;
        const x = e.x - bandW + pr * (e.w + 2 * bandW);
        ctx.save();
        rr(ctx, e.x, e.y, e.w, e.h, c * 0.2);
        ctx.clip();
        ctx.globalAlpha = 0.22 * Math.sin(pr * Math.PI);
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(x, e.y);
        ctx.lineTo(x + bandW, e.y);
        ctx.lineTo(x + bandW - e.h * 0.35, e.y + e.h);
        ctx.lineTo(x - e.h * 0.35, e.y + e.h);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        break;
      }
      case 'pop': {
        const k = easeOutCubic(pr);
        const r = (0.1 + 0.5 * k) * c;
        ctx.globalAlpha = 1 - pr;
        ring(ctx, e.x, e.y, r, e.color, Math.max(1.5, c * 0.05 * (1 - pr) + 1));
        for (let j = 0; j < 4; j++) {
          const a = j * Math.PI / 2 + Math.PI / 4;
          circle(ctx, e.x + Math.cos(a) * r * 1.35, e.y + Math.sin(a) * r * 1.35, 0.035 * c, e.color);
        }
        ctx.globalAlpha = 1;
        break;
      }
    }
  }
}

/** A gold coin and a bold "+$X" with a dark outline, rising and fading. */
function paintCoin(p: Painter, c: number, e: Effect, pr: number): void {
  const ctx = p.ctx;
  const y = e.y - easeOutCubic(pr) * 0.75 * c;
  const scale = 1 + 0.3 * Math.sin(Math.min(1, pr * 3) * Math.PI);
  ctx.globalAlpha = pr < 0.65 ? 1 : 1 - (pr - 0.65) / 0.35;
  ctx.font = p.fontCoin;
  if (e.textW < 0) e.textW = ctx.measureText(e.text).width;
  const cw = 0.2 * c;
  const total = cw + 0.06 * c + e.textW;
  const x = e.x - total / 2;
  const cr = (cw / 2) * scale;
  circleO(ctx, x + cw / 2, y, cr, P.GOLD, 'rgba(90,60,0,0.65)', Math.max(1, c * 0.02));
  circle(ctx, x + cw / 2, y, cr * 0.58, '#FFD866');
  ctx.lineWidth = Math.max(2, c * 0.05);
  ctx.strokeStyle = 'rgba(35,30,15,0.85)';
  ctx.lineJoin = 'round';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.strokeText(e.text, x + cw + 0.06 * c, y);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(e.text, x + cw + 0.06 * c, y);
  ctx.globalAlpha = 1;
}

/** An invoice slip: a small white sheet with a few lines, flying along an arc to the tray. */
function paintSlip(ctx: Ctx, c: number, e: Effect, pr: number): void {
  const k = easeInOutQuad(pr);
  const mx = (e.x + e.x2) / 2;
  const my = Math.min(e.y, e.y2) - 0.9 * c;
  const u = 1 - k;
  const x = u * u * e.x + 2 * u * k * mx + k * k * e.x2;
  const y = u * u * e.y + 2 * u * k * my + k * k * e.y2;
  const rot = (k - 0.5) * 0.6 + Math.sin(pr * 8) * 0.08;
  ctx.globalAlpha = pr > 0.85 ? (1 - pr) / 0.15 : 1;
  ctx.translate(x, y);
  ctx.rotate(rot);
  fillRR(ctx, -0.09 * c, -0.11 * c, 0.2 * c, 0.26 * c, c * 0.01, 'rgba(0,0,0,0.12)');
  fillStrokeRR(ctx, -0.1 * c, -0.13 * c, 0.2 * c, 0.26 * c, c * 0.01, '#FFFFFF', OUTLINE, 1);
  ctx.fillStyle = 'rgba(60,70,90,0.5)';
  ctx.fillRect(-0.06 * c, -0.07 * c, 0.12 * c, 0.016 * c);
  ctx.fillRect(-0.06 * c, -0.03 * c, 0.12 * c, 0.016 * c);
  ctx.fillRect(-0.06 * c, 0.01 * c, 0.08 * c, 0.016 * c);
  circle(ctx, 0.04 * c, 0.07 * c, 0.025 * c, P.GOLD);
  ctx.rotate(-rot);
  ctx.translate(-x, -y);
  ctx.globalAlpha = 1;
}

/** Churn: three grey circles expanding and fading (DESIGN 13: non-converts leave with a grey puff). */
function paintPuff(ctx: Ctx, c: number, e: Effect, pr: number): void {
  ctx.globalAlpha = (1 - pr) * 0.65;
  const k = easeOutCubic(pr);
  const spread = (0.05 + 0.26 * k) * c;
  const r = (0.08 + 0.16 * k) * c;
  const turn = hash2(e.seed, 9) * 0.8;
  for (let j = 0; j < PUFF_N; j++) {
    const a = -Math.PI / 2 + turn + (j * Math.PI * 2) / PUFF_N;
    circle(ctx, e.x + Math.cos(a) * spread, e.y + Math.sin(a) * spread - pr * 0.25 * c, r, '#9DA2AC');
  }
  ctx.globalAlpha = 1;
}

function paintConfetti(ctx: Ctx, c: number, e: Effect, pr: number): void {
  ctx.globalAlpha = pr < 0.7 ? 1 : (1 - pr) / 0.3;
  const t = e.t;
  for (let j = 0; j < CONFETTI_N; j++) {
    const ang = hash2(e.seed, j) * Math.PI * 2;
    const sp = (0.9 + hash2(e.seed, j + 100) * 1.4) * c;
    const vx = Math.cos(ang) * sp;
    const vy = Math.sin(ang) * sp - 1.2 * c;
    const x = e.x + vx * t;
    const y = e.y + vy * t + 1.5 * c * t * t;
    const rot = t * (3 + hash2(e.seed, j + 200) * 6);
    ctx.fillStyle = P.CONFETTI[j % P.CONFETTI.length];
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillRect(-0.06 * c, -0.035 * c, 0.12 * c, 0.07 * c);
    ctx.rotate(-rot);
    ctx.translate(-x, -y);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- placement mode

/** DESIGN 5: the invalid area dims, valid spots get a dashed outline and a bold "+" in the department colour. */
function paintPlacement(p: Painter, l: Layout, pm: PlacementMode, pressed: { x: number; y: number } | null): void {
  const ctx = p.ctx;
  const c = l.cell;
  const color = P.ROOM_BASE[pm.kind];
  ctx.fillStyle = 'rgba(22,26,42,0.25)';
  ctx.fillRect(0, 0, l.width, l.height);
  if (pressed) {
    const fp = footprint(pm.kind, pm.size);
    const r = rectOf(l, pm.floor, pressed.x, pressed.y, fp.w, fp.h, p.tmp);
    fillRR(ctx, r.x, r.y, r.w, r.h, c * 0.16, P.ROOM_GHOST[pm.kind]);
    ctx.setLineDash(p.dash);
    strokeRR(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, c * 0.16, '#FFFFFF', 2);
    ctx.setLineDash(p.noDash);
  }
  const plus = 0.19 * c;
  ctx.lineCap = 'round';
  for (let i = 0; i < pm.spots.length; i++) {
    const s = pm.spots[i];
    const r = cellRect(l, pm.floor, s.x, s.y, p.tmp);
    fillRR(ctx, r.x + 2, r.y + 2, r.w - 4, r.h - 4, c * 0.12, 'rgba(255,255,255,0.3)');
    ctx.setLineDash(p.dash);
    strokeRR(ctx, r.x + 2, r.y + 2, r.w - 4, r.h - 4, c * 0.12, 'rgba(255,255,255,0.95)', Math.max(1.5, c * 0.04));
    ctx.setLineDash(p.noDash);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    ctx.beginPath();
    ctx.moveTo(cx - plus, cy);
    ctx.lineTo(cx + plus, cy);
    ctx.moveTo(cx, cy - plus);
    ctx.lineTo(cx, cy + plus);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = Math.max(5, c * 0.15);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2.5, c * 0.085);
    ctx.stroke();
  }
}
