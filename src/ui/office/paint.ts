/**
 * The painter: draws one frame of the office floor from the cached layout,
 * the cached scene, the crowd and a few per-frame numbers. Everything that can
 * be precomputed (fonts, dashes, tints, label widths) is cached so the per-frame
 * path allocates nothing beyond what the canvas API itself does.
 * DESIGN.md sections 3 (art register), 5 (building), 13 (crowd).
 */
import type { PlacementMode } from '../api';
import { BACK_WALL, SIDE_WALL, cellRect, footprint, rectOf } from './layout';
import type { Layout, Rect } from './layout';
import type { RoomView, Scene, SeatInfo } from './scene';
import type { Crowd, Effect, Walker } from './walkers';
import * as P from './palette';
import { FONT, circle, clearShadow, drawFigure, drawGlyph, fillRR, line, ring, rr, shadowRR, strokeRR } from './primitives';
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

export interface Painter {
  ctx: Ctx;
  cell: number;
  fontLabel: string;
  fontSign: string;
  fontCoin: string;
  fontBadge: string;
  dash: number[];
  noDash: number[];
  roadDash: number[];
  sky: CanvasGradient | null;
  skyW: number;
  skyH: number;
  signText: string;
  signAr: number;
  signW: number;
  stairShades: string[];
  tmp: Rect;
}

const STAIR_STEPS = 6;
const MAX_PAPERS = 12;
const CONFETTI_N = 22;
const WALKER_H = 0.62;
const SEAT_H = 0.46;

export function createPainter(ctx: Ctx): Painter {
  const shades: string[] = [];
  for (let i = 0; i < STAIR_STEPS; i++) shades.push(P.mix('#F2F0EC', '#C9C4BC', i / (STAIR_STEPS - 1)));
  const p: Painter = {
    ctx,
    cell: 0,
    fontLabel: '',
    fontSign: '',
    fontCoin: '',
    fontBadge: '',
    dash: [4, 3],
    noDash: [],
    roadDash: [12, 10],
    sky: null,
    skyW: 0,
    skyH: 0,
    signText: '',
    signAr: NaN,
    signW: -1,
    stairShades: shades,
    tmp: { x: 0, y: 0, w: 0, h: 0 },
  };
  setPainterCell(p, 40);
  return p;
}

/** Fonts and dash patterns scale with the cell; call when the layout changes. */
export function setPainterCell(p: Painter, cell: number): void {
  p.cell = cell;
  p.fontLabel = `600 ${Math.max(10, Math.round(cell * 0.21))}px ${FONT}`;
  p.fontSign = `600 ${Math.max(9, Math.round(cell * 0.155))}px ${FONT}`;
  p.fontCoin = `800 ${Math.max(11, Math.round(cell * 0.24))}px ${FONT}`;
  p.fontBadge = `700 ${Math.max(9, Math.round(cell * 0.16))}px ${FONT}`;
  p.dash = [Math.max(3, cell * 0.12), Math.max(3, cell * 0.09)];
  p.roadDash = [Math.max(6, cell * 0.5), Math.max(5, cell * 0.4)];
  p.signAr = NaN;
  p.signW = -1;
}

export function paintFrame(p: Painter, l: Layout, scene: Scene, crowd: Crowd, info: FrameInfo): void {
  paintBackground(p, l);
  paintStreet(p, l, scene);
  for (let f = 0; f < l.floors; f++) paintSlab(p, l, f as 0 | 1);
  if (l.stair) paintStairs(p, l);
  for (let i = 0; i < scene.rooms.length; i++) paintRoom(p, l, scene, scene.rooms[i], crowd, info);
  paintDoor(p, l, scene);
  if (scene.lobby && info.ar > 0) paintSign(p, l, scene, info);
  if (info.selectedRoomId) paintSelection(p, l, scene, info);
  paintWalkers(p, l, crowd);
  paintEffects(p, l, crowd);
  if (info.placement) paintPlacement(p, l, info.placement, info.pressedSpot);
}

// ---------------------------------------------------------------- ground

function paintBackground(p: Painter, l: Layout): void {
  const ctx = p.ctx;
  if (!p.sky || p.skyW !== l.width || p.skyH !== l.height) {
    const g = ctx.createLinearGradient(0, 0, 0, l.height);
    g.addColorStop(0, '#D3E6F4');
    g.addColorStop(0.22, '#B7DC9F');
    g.addColorStop(1, P.GRASS);
    p.sky = g;
    p.skyW = l.width;
    p.skyH = l.height;
  }
  ctx.fillStyle = p.sky;
  ctx.fillRect(0, 0, l.width, l.height);
}

function paintStreet(p: Painter, l: Layout, scene: Scene): void {
  const ctx = p.ctx;
  const c = l.cell;
  const W = l.width;
  const sy = l.streetTop;
  const sh = l.streetH;
  const pave = c * 0.55;
  ctx.fillStyle = P.PAVEMENT;
  ctx.fillRect(0, sy, W, pave);
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const slab = c * 0.75;
  for (let x = l.x0 % slab; x < W; x += slab) {
    ctx.moveTo(x, sy);
    ctx.lineTo(x, sy + pave);
  }
  ctx.stroke();
  const d = scene.anchors.door;
  ctx.fillStyle = P.PAVEMENT_LIGHT;
  ctx.fillRect(d.x - 0.22 * c, sy, 0.44 * c, pave);
  ctx.fillStyle = P.KERB;
  ctx.fillRect(0, sy + pave - c * 0.06, W, c * 0.06);
  ctx.fillStyle = P.STREET;
  ctx.fillRect(0, sy + pave, W, sh - pave);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, c * 0.035);
  ctx.setLineDash(p.roadDash);
  ctx.beginPath();
  const ry = sy + pave + (sh - pave) * 0.55;
  ctx.moveTo(0, ry);
  ctx.lineTo(W, ry);
  ctx.stroke();
  ctx.setLineDash(p.noDash);
}

function paintSlab(p: Painter, l: Layout, floor: 0 | 1): void {
  const ctx = p.ctx;
  const c = l.cell;
  const r = rectOf(l, floor, 0, 0, l.cols, l.rowsPerFloor, p.tmp);
  const rad = c * 0.22;
  shadowRR(ctx, r.x, r.y, r.w, r.h, rad, '#DDD9D3', c * 0.35, c * 0.1, 'rgba(30,40,70,0.22)');
  ctx.save();
  rr(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.clip();
  ctx.strokeStyle = 'rgba(40,40,60,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < l.cols; i++) {
    const x = Math.round(r.x + i * c) + 0.5;
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
  }
  for (let j = 1; j < l.rowsPerFloor; j++) {
    const y = Math.round(r.y + j * c) + 0.5;
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
  }
  ctx.stroke();
  ctx.restore();
  strokeRR(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad, 'rgba(60,60,90,0.16)', 1);
}

function paintStairs(p: Painter, l: Layout): void {
  const ctx = p.ctx;
  const s = l.stair;
  if (!s) return;
  const c = l.cell;
  shadowRR(ctx, s.x, s.y - c * 0.06, s.w, s.h + c * 0.12, c * 0.08, '#E6E3DD', c * 0.2, c * 0.05, 'rgba(30,40,70,0.2)');
  const stepH = s.h / STAIR_STEPS;
  for (let i = 0; i < STAIR_STEPS; i++) {
    ctx.fillStyle = p.stairShades[i];
    ctx.fillRect(s.x + c * 0.1, s.y + i * stepH, s.w - c * 0.2, Math.max(1, stepH - 1));
  }
  const lw = Math.max(1, c * 0.04);
  line(ctx, s.x + c * 0.06, s.y - c * 0.04, s.x + c * 0.06, s.y + s.h + c * 0.04, '#8E8A82', lw);
  line(ctx, s.x + s.w - c * 0.06, s.y - c * 0.04, s.x + s.w - c * 0.06, s.y + s.h + c * 0.04, '#8E8A82', lw);
}

function paintDoor(p: Painter, l: Layout, scene: Scene): void {
  const ctx = p.ctx;
  const c = l.cell;
  const d = scene.anchors.door;
  fillRR(ctx, d.x - 0.2 * c, d.y - 0.1 * c, 0.4 * c, 0.14 * c, c * 0.03, '#4D5262');
  fillRR(ctx, d.x - 0.17 * c, d.y - 0.085 * c, 0.34 * c, 0.1 * c, c * 0.02, '#6C7384');
  circle(ctx, d.x + 0.1 * c, d.y - 0.035 * c, c * 0.016, '#E8E2D4');
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

  shadowRR(ctx, r.x, r.y, r.w, r.h, rad, P.ROOM_FLOOR[k], c * 0.2, c * 0.09, 'rgba(30,35,70,0.22)');
  ctx.save();
  rr(ctx, r.x, r.y, r.w, r.h, rad);
  ctx.clip();
  ctx.fillStyle = P.ROOM_SIDE[k];
  ctx.fillRect(r.x, r.y, sideW, r.h);
  ctx.fillRect(r.x + r.w - sideW, r.y, sideW, r.h);
  ctx.fillStyle = P.ROOM_BACK[k];
  ctx.fillRect(r.x, r.y, r.w, backH);
  if (k === 'garage') paintRollupDoor(ctx, c, r, sideW, backH);
  // faint planks (DESIGN 3: wood floors) under the pastel tint
  ctx.strokeStyle = 'rgba(90,60,30,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = r.y + backH + c * 0.33; y < r.y + r.h - c * 0.05; y += c * 0.33) {
    const yy = Math.round(y) + 0.5;
    ctx.moveTo(r.x + sideW, yy);
    ctx.lineTo(r.x + r.w - sideW, yy);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(20,20,40,0.08)';
  ctx.fillRect(r.x, r.y + backH, r.w, c * 0.045);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(r.x, r.y, r.w, Math.max(1, c * 0.03));
  ctx.restore();
  strokeRR(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, rad, P.ROOM_EDGE[k], 1);

  paintPlant(ctx, c, v.plant.x, v.plant.y);
  if (k === 'product') paintRacks(ctx, c, v, scene, info.time);
  else if (k === 'lobby' && scene.lobby) paintLobby(p, c, scene, info);
  else if (k === 'garage') paintGarage(ctx, c, v, scene);
  else if (k === 'demo') paintDemo(ctx, c, v, backH);

  // desks and seated people, row by row so lower rows overlap upper ones
  const n = Math.max(v.slots.length, v.seats.length);
  for (let i = 0; i < n; i++) {
    const seat = i < v.seats.length ? v.seats[i] : null;
    if (seat && !walkingIn(crowd, seat.personId)) paintSeat(ctx, c, seat, info.time);
    if (i < v.deskCount) paintDesk(ctx, c, v.slots[i].x, v.slots[i].y);
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
  fillRR(ctx, x - 0.07 * c, y - 0.02 * c, 0.14 * c, 0.12 * c, c * 0.03, '#B9785A');
  circle(ctx, x, y - 0.1 * c, 0.08 * c, '#6FBF73');
  circle(ctx, x - 0.07 * c, y - 0.05 * c, 0.065 * c, '#5BAF63');
  circle(ctx, x + 0.07 * c, y - 0.05 * c, 0.065 * c, '#7CCB7F');
}

function paintRacks(ctx: Ctx, c: number, v: RoomView, scene: Scene, time: number): void {
  const n = Math.max(1, Math.min(3, scene.servers));
  const x0 = v.rect.x + SIDE_WALL * c + 0.08 * c;
  const y0 = v.rect.y + BACK_WALL * c + 0.03 * c;
  const owned = scene.servers;
  for (let i = 0; i < n; i++) {
    const rx = x0 + i * 0.3 * c;
    fillRR(ctx, rx, y0, 0.24 * c, 0.42 * c, c * 0.03, '#3E4556');
    const lit = i < owned;
    for (let j = 0; j < 4; j++) {
      const ly = y0 + 0.07 * c + j * 0.09 * c;
      ctx.fillStyle = '#5B6478';
      ctx.fillRect(rx + 0.11 * c, ly - 0.012 * c, 0.09 * c, 0.024 * c);
      const blink = (Math.floor(time * (2.5 + j * 0.9) + i * 1.7) & 1) === 0;
      const color = !lit ? '#555C6B' : scene.serversShort > 0 && j === 0 ? (blink ? '#FF6B6B' : '#8A2E2E') : blink ? '#5EF08B' : '#2E8B57';
      circle(ctx, rx + 0.06 * c, ly, 0.02 * c, color);
    }
  }
}

function paintCoffee(ctx: Ctx, c: number, x: number, y: number): void {
  fillRR(ctx, x - 0.11 * c, y - 0.16 * c, 0.22 * c, 0.3 * c, c * 0.03, '#3F3A44');
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
  circle(ctx, rec.x + 0.14 * c, rec.y + 0.02 * c, 0.045 * c, P.GOLD);
  ctx.fillStyle = '#8A6A00';
  ctx.fillRect(rec.x + 0.08 * c, rec.y + 0.05 * c, 0.12 * c, 0.02 * c);

  const tr = lb.tray;
  fillRR(ctx, tr.x, tr.y, tr.w, tr.h, c * 0.03, '#AEB5C2');
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
 * "Owed to you $X": a floating sign above the invoice tray, drawn after every
 * room so nothing covers it, clamped to the lot when the text is wider than the lobby.
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
  const sh = 0.26 * c;
  const sw = p.signW + 0.46 * c;
  let sx = lb.sign.x - sw;
  sx = Math.max(l.x0 + 2, Math.min(sx, l.x0 + l.lotW - sw - 2));
  const sy = lb.sign.y - sh / 2;
  shadowRR(ctx, sx, sy, sw, sh, sh / 2, 'rgba(255,255,255,0.94)', c * 0.08, c * 0.02, 'rgba(30,30,60,0.18)');
  circle(ctx, sx + 0.16 * c, lb.sign.y, 0.085 * c, P.GOLD);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = p.fontBadge;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('$', sx + 0.16 * c, lb.sign.y + 0.5);
  ctx.font = p.fontSign;
  ctx.fillStyle = P.INK;
  ctx.textAlign = 'left';
  ctx.fillText(p.signText, sx + 0.32 * c, lb.sign.y + 0.5);
}

function paintGarage(ctx: Ctx, c: number, v: RoomView, scene: Scene): void {
  const r = v.rect;
  const bx = r.x + 0.2 * c;
  const by = r.y + r.h - 0.2 * c;
  fillRR(ctx, bx, by - 0.32 * c, 0.32 * c, 0.32 * c, c * 0.02, '#D7B48A');
  fillRR(ctx, bx + 0.36 * c, by - 0.26 * c, 0.26 * c, 0.26 * c, c * 0.02, '#CFA87E');
  fillRR(ctx, bx + 0.04 * c, by - 0.58 * c, 0.24 * c, 0.24 * c, c * 0.02, '#E0BF98');
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
  shadowRR(ctx, cx - 0.5 * c, sy, 1.0 * c, 0.42 * c, c * 0.04, '#3C4252', c * 0.1, c * 0.03, 'rgba(30,30,60,0.2)');
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
      circle(ctx, cx - 0.35 * c + col * 0.35 * c, r.y + 1.15 * c + row * 0.32 * c, 0.075 * c, '#7D8FB3');
    }
  }
}

function paintDesk(ctx: Ctx, c: number, x: number, y: number): void {
  const w = 0.54 * c;
  const h = 0.22 * c;
  fillRR(ctx, x - w / 2 + c * 0.01, y - h / 2 + c * 0.035, w, h, c * 0.05, 'rgba(30,30,60,0.14)');
  fillRR(ctx, x - w / 2, y - h / 2, w, h, c * 0.05, '#D8BD95');
  fillRR(ctx, x - w / 2, y - h / 2, w, h * 0.45, c * 0.05, 'rgba(255,255,255,0.25)');
  const mw = 0.2 * c;
  const mh = 0.14 * c;
  const mx = x + 0.1 * c - mw / 2;
  const my = y - h / 2 - mh + c * 0.03;
  ctx.fillStyle = '#596070';
  ctx.fillRect(mx + mw / 2 - c * 0.02, my + mh - c * 0.01, c * 0.04, c * 0.04);
  fillRR(ctx, mx, my, mw, mh, c * 0.02, '#3C4252');
  fillRR(ctx, mx + c * 0.015, my + c * 0.015, mw - c * 0.03, mh - c * 0.03, c * 0.01, '#8FB8F0');
}

function paintSeat(ctx: Ctx, c: number, s: SeatInfo, time: number): void {
  const bob = Math.sin(time * 2.2 + s.phase) * 0.012 * c;
  drawFigure(ctx, s.x, s.y, SEAT_H * c, P.DEPT[s.role], P.SKIN[s.skin], P.HAIR[s.hair], bob, 0, true, 1, 1);
  if (s.founder) circle(ctx, s.x + 0.06 * c, s.y - 0.17 * c + bob, 0.03 * c, P.GOLD);
}

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
  shadowRR(ctx, x, y, w, h, h / 2, 'rgba(255,255,255,0.9)', c * 0.06, c * 0.015, 'rgba(30,30,60,0.14)');
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
  ctx.shadowBlur = c * 0.4 * pulse;
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
      fillRR(ctx, w.x + w.dir * 0.17 * c - 0.07 * c, w.y - 0.24 * c + bob, 0.14 * c, 0.11 * c, c * 0.02, '#3B3F4A');
    }
    if (w.badge > 1) {
      ctx.font = p.fontBadge;
      if (w.badgeW < 0) w.badgeW = ctx.measureText(w.badgeText).width;
      const bw = w.badgeW + 0.14 * c;
      const bh = 0.2 * c;
      const bx = w.x - bw / 2;
      const by = w.y - h - 0.26 * c + bob;
      fillRR(ctx, bx, by, bw, bh, bh / 2, 'rgba(255,255,255,0.92)');
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

function paintCoin(p: Painter, c: number, e: Effect, pr: number): void {
  const ctx = p.ctx;
  const y = e.y - easeOutCubic(pr) * 0.7 * c;
  const scale = 1 + 0.3 * Math.sin(Math.min(1, pr * 3) * Math.PI);
  ctx.globalAlpha = pr < 0.65 ? 1 : 1 - (pr - 0.65) / 0.35;
  ctx.font = p.fontCoin;
  if (e.textW < 0) e.textW = ctx.measureText(e.text).width;
  const cw = 0.18 * c;
  const total = cw + 0.06 * c + e.textW;
  const x = e.x - total / 2;
  circle(ctx, x + cw / 2, y, (cw / 2) * scale, P.GOLD);
  circle(ctx, x + cw / 2, y, cw * 0.31 * scale, '#FFD866');
  ctx.lineWidth = Math.max(2, c * 0.06);
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineJoin = 'round';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.strokeText(e.text, x + cw + 0.06 * c, y);
  ctx.fillStyle = '#8A5A00';
  ctx.fillText(e.text, x + cw + 0.06 * c, y);
  ctx.globalAlpha = 1;
}

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
  fillRR(ctx, -0.1 * c, -0.13 * c, 0.2 * c, 0.26 * c, c * 0.01, '#FFFFFF');
  ctx.fillStyle = 'rgba(60,70,90,0.5)';
  ctx.fillRect(-0.06 * c, -0.07 * c, 0.12 * c, 0.016 * c);
  ctx.fillRect(-0.06 * c, -0.03 * c, 0.12 * c, 0.016 * c);
  ctx.fillRect(-0.06 * c, 0.01 * c, 0.08 * c, 0.016 * c);
  circle(ctx, 0.04 * c, 0.07 * c, 0.025 * c, P.GOLD);
  ctx.rotate(-rot);
  ctx.translate(-x, -y);
  ctx.globalAlpha = 1;
}

function paintPuff(ctx: Ctx, c: number, e: Effect, pr: number): void {
  ctx.globalAlpha = (1 - pr) * 0.6;
  const spread = (0.06 + 0.25 * easeOutCubic(pr)) * c;
  const r = (0.09 + 0.14 * pr) * c;
  for (let j = 0; j < 4; j++) {
    const a = hash2(e.seed, j) * Math.PI * 2;
    circle(ctx, e.x + Math.cos(a) * spread, e.y + Math.sin(a) * spread - pr * 0.2 * c, r, '#9A9EA8');
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
    ctx.fillRect(-0.05 * c, -0.03 * c, 0.1 * c, 0.06 * c);
    ctx.rotate(-rot);
    ctx.translate(-x, -y);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- placement mode

function paintPlacement(p: Painter, l: Layout, pm: PlacementMode, pressed: { x: number; y: number } | null): void {
  const ctx = p.ctx;
  const c = l.cell;
  ctx.fillStyle = 'rgba(22,26,42,0.42)';
  ctx.fillRect(0, 0, l.width, l.height);
  if (pressed) {
    const fp = footprint(pm.kind, pm.size);
    const r = rectOf(l, pm.floor, pressed.x, pressed.y, fp.w, fp.h, p.tmp);
    fillRR(ctx, r.x, r.y, r.w, r.h, c * 0.16, P.ROOM_GHOST[pm.kind]);
    ctx.setLineDash(p.dash);
    strokeRR(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, c * 0.16, '#FFFFFF', 2);
    ctx.setLineDash(p.noDash);
  }
  const plus = 0.18 * c;
  for (let i = 0; i < pm.spots.length; i++) {
    const s = pm.spots[i];
    const r = cellRect(l, pm.floor, s.x, s.y, p.tmp);
    fillRR(ctx, r.x + 2, r.y + 2, r.w - 4, r.h - 4, c * 0.12, 'rgba(255,255,255,0.28)');
    ctx.setLineDash(p.dash);
    strokeRR(ctx, r.x + 2, r.y + 2, r.w - 4, r.h - 4, c * 0.12, 'rgba(255,255,255,0.95)', Math.max(1.5, c * 0.035));
    ctx.setLineDash(p.noDash);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(2, c * 0.07);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - plus, cy);
    ctx.lineTo(cx + plus, cy);
    ctx.moveTo(cx, cy - plus);
    ctx.lineTo(cx, cy + plus);
    ctx.stroke();
  }
}

