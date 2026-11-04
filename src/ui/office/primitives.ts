/**
 * Canvas 2D primitives shared by the painter: rounded rects, soft shadows, the
 * big-headed figure (four-frame walk cycle, six outfits, five hairstyles, the
 * bag, laptop, briefcase or box it carries) and the room glyphs, all drawn with
 * paths (no images, no fonts beyond the system stack). Pure drawing calls, no
 * state. DESIGN.md section 3: rounded, pastel, soft shadows, head ≈ 45% of a figure.
 */
import type { RoomKind } from '../../sim/types';
import { shades } from './palette';

export type Ctx = CanvasRenderingContext2D;

export const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
/** the thin dark outline on figures, props and cars (DESIGN 3: a little outline at low alpha) */
export const OUTLINE = 'rgba(30,30,50,0.25)';
const EYE = '#2B2B33';
const SMILE = 'rgba(70,40,40,0.45)';
const SHOE = '#3A3F4C';
const SHADOW = 'rgba(30,30,50,0.16)';
const COLLAR = '#FFFFFF';
const BLAZER_SHIRT = '#F3F4F7';
const BAG = '#7A5A3C';
const BAG_DARK = '#5C4228';
const LAPTOP = '#B8BEC8';
const LAPTOP_EDGE = '#6B7280';
const CASE = '#3B3F4A';
const CASE_HANDLE = '#6B7280';
const BOX = '#D7B48A';
const BOX_TAPE = '#C09A6C';

/** what a figure carries: visitors come with a bag or a laptop, prospects with a briefcase, leavers with a box */
export type Carry = 0 | 1 | 2 | 3 | 4;
export const CARRY_NONE: Carry = 0;
export const CARRY_BAG: Carry = 1;
export const CARRY_LAPTOP: Carry = 2;
export const CARRY_CASE: Carry = 3;
export const CARRY_BOX: Carry = 4;

/** six outfits (tee, hoodie, shirt, blazer, sweater, tunic) and five hairstyles (short, bob, bun, spiky, long) */
export const OUTFITS = 6;
export const HAIR_STYLES = 5;
/** frames in the walk cycle (legs apart, passing, apart the other way, passing) */
export const WALK_FRAMES = 4;

/** How a figure looks; colours are palette strings, the rest indices. Built once per person or spawn, never per frame. */
export interface Look {
  body: string;
  skin: string;
  hair: string;
  trousers: string;
  outfit: number;
  style: number;
  carry: Carry;
}

export function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function fillRR(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function strokeRR(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, stroke: string, lw: number): void {
  rr(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

/** A rounded rect filled and then outlined. */
export function fillStrokeRR(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, stroke: string, lw: number): void {
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

export function clearShadow(ctx: Ctx): void {
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** A rounded rect with a soft drop shadow (the shadow state is reset afterwards). */
export function shadowRR(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, blur: number, offY: number, shadow: string): void {
  ctx.shadowColor = shadow;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = offY;
  fillRR(ctx, x, y, w, h, r, fill);
  clearShadow(ctx);
}

export function circle(ctx: Ctx, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A circle filled and then outlined. */
export function circleO(ctx: Ctx, x: number, y: number, r: number, fill: string, stroke: string, lw: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

export function ring(ctx: Ctx, x: number, y: number, r: number, stroke: string, lw: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

export function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string): void {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, stroke: string, lw: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

/** A rounded line: a limb. */
function limb(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, stroke: string, lw: number): void {
  ctx.lineCap = 'round';
  line(ctx, x1, y1, x2, y2, stroke, lw);
  ctx.lineCap = 'butt';
}

/**
 * The big-headed figure. (x, y) is the feet position, h the full height; the head
 * is ≈ 45% of h and the body a rounded capsule with the outfit's details, both with
 * a thin dark outline (DESIGN 3). `bob` shifts everything but the ground shadow.
 * `frame` is the walk-cycle frame (0..3) or −1 when standing or seated; the legs and
 * arms take their pose from it. `dir` is the facing direction (±1).
 */
export function drawFigure(
  ctx: Ctx, x: number, y: number, h: number, look: Look,
  bob: number, frame: number, seated: boolean, alpha: number, dir: number,
): void {
  const R = h * 0.225;
  const bodyW = h * 0.44;
  const bodyH = seated ? h * 0.3 : h * 0.4;
  const bodyTop = y - (seated ? h * 0.47 : h * 0.54) + bob;
  const hipY = bodyTop + bodyH - h * 0.03;
  const lw = Math.max(0.8, h * 0.03);
  const sh = shades(look.body);
  const hy = bodyTop - R * 0.7;
  const faceY = hy + R * 0.1;
  const faceR = R * 0.92;
  const f = frame < 0 ? -1 : frame & 3;
  if (alpha < 1) ctx.globalAlpha = Math.max(0, alpha);

  if (!seated) ellipse(ctx, x, y + h * 0.015, bodyW * 0.62, h * 0.055, SHADOW);
  // long hair hangs behind the shoulders, so it goes under the body
  if (look.style === 4) fillStrokeRR(ctx, x - R * 1.1, hy - R * 1.1, R * 2.2, R * 3.0, R * 0.9, look.hair, OUTLINE, lw);

  if (!seated) {
    // legs: apart on frames 0 and 2 (one forward, one back), passing on 1 and 3 (one foot lifted)
    const spread = h * 0.1;
    const step = h * 0.09 * dir;
    const lift = h * 0.035;
    let lx = x - spread;
    let rx = x + spread;
    let ly = y;
    let ry = y;
    if (f === 0) { lx += step; rx -= step; }
    else if (f === 2) { lx -= step; rx += step; }
    else if (f === 1) { lx = x - spread * 0.8; rx = x + spread * 0.8; ly -= lift; }
    else if (f === 3) { lx = x - spread * 0.8; rx = x + spread * 0.8; ry -= lift; }
    const legW = h * 0.1;
    limb(ctx, x - h * 0.08, hipY, lx, ly - h * 0.045, look.trousers, legW);
    limb(ctx, x + h * 0.08, hipY, rx, ry - h * 0.045, look.trousers, legW);
    circleO(ctx, lx, ly - h * 0.045, h * 0.065, SHOE, OUTLINE, lw);
    circleO(ctx, rx, ry - h * 0.045, h * 0.065, SHOE, OUTLINE, lw);
  }

  // the body and its outfit
  fillStrokeRR(ctx, x - bodyW / 2, bodyTop, bodyW, bodyH, bodyW * 0.45, look.body, OUTLINE, lw);
  drawOutfit(ctx, look.outfit, x, bodyTop, bodyW, bodyH, look.body, sh.light, sh.dark, lw);

  // arms swing against the legs; seated figures reach forward to the desk
  const armW = h * 0.085;
  const shY = bodyTop + h * 0.07;
  let lhx: number;
  let rhx: number;
  let lhy: number;
  let rhy: number;
  if (seated) {
    lhx = x - bodyW * 0.38;
    rhx = x + bodyW * 0.38;
    lhy = rhy = bodyTop + bodyH * 0.95;
  } else {
    const a = f === 0 ? 1 : f === 2 ? -1 : 0;
    const swing = a * dir * h * 0.08;
    lhx = x - bodyW * 0.55 - swing;
    rhx = x + bodyW * 0.55 + swing;
    lhy = rhy = bodyTop + bodyH * 0.78 - Math.abs(a) * h * 0.03;
  }
  limb(ctx, x - bodyW * 0.4, shY, lhx, lhy, look.body, armW);
  limb(ctx, x + bodyW * 0.4, shY, rhx, rhy, look.body, armW);
  circleO(ctx, lhx, lhy, h * 0.05, look.skin, OUTLINE, lw);
  circleO(ctx, rhx, rhy, h * 0.05, look.skin, OUTLINE, lw);
  if (!seated && look.carry !== CARRY_NONE) {
    const hx = dir > 0 ? rhx : lhx;
    const hyy = dir > 0 ? rhy : lhy;
    drawCarry(ctx, look.carry, x, hx, hyy, bodyTop, bodyW, bodyH, h, dir, look.skin, lw);
  }

  // the head: hair behind, the face, the fringe, eyes and a smile
  drawHairBack(ctx, look.style, x, hy, R, look.hair, lw);
  circleO(ctx, x, faceY, faceR, look.skin, OUTLINE, lw);
  ctx.beginPath();
  ctx.arc(x, faceY, faceR, Math.PI * 1.28, Math.PI * 1.72);
  ctx.closePath();
  ctx.fillStyle = look.hair;
  ctx.fill();
  const ex = R * 0.3;
  const ey = faceY + R * 0.06;
  const off = dir * R * 0.1;
  circle(ctx, x - ex + off, ey, R * 0.1, EYE);
  circle(ctx, x + ex + off, ey, R * 0.1, EYE);
  ctx.beginPath();
  ctx.arc(x + off, ey + R * 0.24, R * 0.22, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.strokeStyle = SMILE;
  ctx.lineWidth = Math.max(0.8, R * 0.08);
  ctx.stroke();
  if (alpha < 1) ctx.globalAlpha = 1;
}

function drawHairBack(ctx: Ctx, style: number, x: number, hy: number, R: number, hair: string, lw: number): void {
  switch (style) {
    case 1: // bob: hair down to the chin
      fillStrokeRR(ctx, x - R * 1.05, hy - R * 1.1, R * 2.1, R * 2.3, R * 0.95, hair, OUTLINE, lw);
      break;
    case 2: // bun
      circleO(ctx, x, hy - R * 1.2, R * 0.36, hair, OUTLINE, lw);
      circleO(ctx, x, hy - R * 0.12, R, hair, OUTLINE, lw);
      break;
    case 3: { // spiky
      ctx.beginPath();
      ctx.moveTo(x - R * 0.7, hy - R * 0.8);
      ctx.lineTo(x - R * 0.5, hy - R * 1.45);
      ctx.lineTo(x - R * 0.2, hy - R * 1.0);
      ctx.lineTo(x, hy - R * 1.55);
      ctx.lineTo(x + R * 0.2, hy - R * 1.0);
      ctx.lineTo(x + R * 0.5, hy - R * 1.45);
      ctx.lineTo(x + R * 0.7, hy - R * 0.8);
      ctx.closePath();
      ctx.fillStyle = hair;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = lw;
      ctx.stroke();
      circleO(ctx, x, hy - R * 0.12, R, hair, OUTLINE, lw);
      break;
    }
    default: // short (and the top of long hair)
      circleO(ctx, x, hy - R * 0.12, R, hair, OUTLINE, lw);
      break;
  }
}

function drawOutfit(ctx: Ctx, outfit: number, x: number, top: number, w: number, h: number, body: string, light: string, dark: string, lw: number): void {
  switch (outfit) {
    case 1: { // hoodie: hood, pocket, drawstrings
      ellipse(ctx, x, top + w * 0.1, w * 0.34, w * 0.16, dark);
      fillRR(ctx, x - w * 0.3, top + h * 0.6, w * 0.6, h * 0.3, w * 0.1, dark);
      line(ctx, x - w * 0.08, top + w * 0.16, x - w * 0.1, top + h * 0.5, light, Math.max(0.6, lw * 0.8));
      line(ctx, x + w * 0.08, top + w * 0.16, x + w * 0.1, top + h * 0.5, light, Math.max(0.6, lw * 0.8));
      break;
    }
    case 2: { // shirt: collar and buttons
      ctx.beginPath();
      ctx.moveTo(x - w * 0.2, top);
      ctx.lineTo(x, top + h * 0.2);
      ctx.lineTo(x + w * 0.2, top);
      ctx.closePath();
      ctx.fillStyle = COLLAR;
      ctx.fill();
      circle(ctx, x, top + h * 0.38, w * 0.045, light);
      circle(ctx, x, top + h * 0.58, w * 0.045, light);
      circle(ctx, x, top + h * 0.78, w * 0.045, light);
      break;
    }
    case 3: { // blazer: a shirt panel in a V, lapels
      ctx.beginPath();
      ctx.moveTo(x - w * 0.22, top + lw);
      ctx.lineTo(x, top + h * 0.5);
      ctx.lineTo(x + w * 0.22, top + lw);
      ctx.closePath();
      ctx.fillStyle = BLAZER_SHIRT;
      ctx.fill();
      line(ctx, x - w * 0.22, top + lw, x, top + h * 0.5, dark, Math.max(0.8, lw));
      line(ctx, x + w * 0.22, top + lw, x, top + h * 0.5, dark, Math.max(0.8, lw));
      break;
    }
    case 4: { // sweater: a chest stripe
      ctx.fillStyle = light;
      ctx.fillRect(x - w / 2 + lw, top + h * 0.38, w - 2 * lw, h * 0.16);
      break;
    }
    case 5: { // tunic: a flared hem and a belt
      ctx.beginPath();
      ctx.moveTo(x - w / 2, top + h * 0.55);
      ctx.lineTo(x - w * 0.64, top + h);
      ctx.lineTo(x + w * 0.64, top + h);
      ctx.lineTo(x + w / 2, top + h * 0.55);
      ctx.closePath();
      ctx.fillStyle = body;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.fillStyle = dark;
      ctx.fillRect(x - w / 2, top + h * 0.5, w, h * 0.09);
      break;
    }
    default: // tee: a neckline
      ellipse(ctx, x, top + w * 0.06, w * 0.15, w * 0.07, dark);
      break;
  }
}

function drawCarry(
  ctx: Ctx, carry: Carry, x: number, hx: number, hy: number, bodyTop: number, bodyW: number, bodyH: number,
  h: number, dir: number, skin: string, lw: number,
): void {
  switch (carry) {
    case CARRY_BAG: {
      line(ctx, x + dir * bodyW * 0.3, bodyTop + h * 0.08, hx, hy, BAG_DARK, Math.max(0.6, lw * 0.9));
      fillStrokeRR(ctx, hx - h * 0.08, hy + h * 0.01, h * 0.16, h * 0.14, h * 0.025, BAG, OUTLINE, lw);
      circle(ctx, hx, hy + h * 0.05, h * 0.018, BAG_DARK);
      break;
    }
    case CARRY_LAPTOP: {
      const ly = bodyTop + bodyH * 0.6;
      fillStrokeRR(ctx, hx - h * 0.12, ly - h * 0.035, h * 0.24, h * 0.07, h * 0.012, LAPTOP, LAPTOP_EDGE, Math.max(0.6, lw * 0.8));
      circle(ctx, hx, ly + h * 0.055, h * 0.045, skin);
      break;
    }
    case CARRY_CASE: {
      fillStrokeRR(ctx, hx - h * 0.085, hy + h * 0.02, h * 0.17, h * 0.13, h * 0.02, CASE, OUTLINE, lw);
      fillRR(ctx, hx - h * 0.035, hy - h * 0.005, h * 0.07, h * 0.03, h * 0.01, CASE_HANDLE);
      break;
    }
    case CARRY_BOX: {
      const bx = x + dir * h * 0.04;
      const by = bodyTop + bodyH * 0.55;
      fillStrokeRR(ctx, bx - h * 0.14, by - h * 0.1, h * 0.28, h * 0.2, h * 0.015, BOX, OUTLINE, lw);
      ctx.fillStyle = BOX_TAPE;
      ctx.fillRect(bx - h * 0.02, by - h * 0.1, h * 0.04, h * 0.2);
      circleO(ctx, bx - h * 0.14, by, h * 0.045, skin, OUTLINE, lw);
      circleO(ctx, bx + h * 0.14, by, h * 0.045, skin, OUTLINE, lw);
      break;
    }
    default:
      break;
  }
}

/** Room glyphs drawn with paths, centred on (x, y) inside a box of side s. */
export function drawGlyph(ctx: Ctx, kind: RoomKind, x: number, y: number, s: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.14);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'product': { // </>
      ctx.beginPath();
      ctx.moveTo(x - s * 0.18, y - s * 0.3);
      ctx.lineTo(x - s * 0.46, y);
      ctx.lineTo(x - s * 0.18, y + s * 0.3);
      ctx.moveTo(x + s * 0.18, y - s * 0.3);
      ctx.lineTo(x + s * 0.46, y);
      ctx.lineTo(x + s * 0.18, y + s * 0.3);
      ctx.moveTo(x + s * 0.1, y - s * 0.4);
      ctx.lineTo(x - s * 0.1, y + s * 0.4);
      ctx.stroke();
      break;
    }
    case 'sales': { // chart bars
      ctx.fillRect(x - s * 0.42, y + s * 0.1, s * 0.2, s * 0.3);
      ctx.fillRect(x - s * 0.1, y - s * 0.12, s * 0.2, s * 0.52);
      ctx.fillRect(x + s * 0.22, y - s * 0.4, s * 0.2, s * 0.8);
      break;
    }
    case 'support': { // headset
      ctx.beginPath();
      ctx.arc(x, y + s * 0.05, s * 0.36, Math.PI, Math.PI * 2);
      ctx.stroke();
      fillRR(ctx, x - s * 0.48, y, s * 0.2, s * 0.3, s * 0.06, color);
      fillRR(ctx, x + s * 0.28, y, s * 0.2, s * 0.3, s * 0.06, color);
      ctx.beginPath();
      ctx.moveTo(x + s * 0.38, y + s * 0.3);
      ctx.lineTo(x + s * 0.3, y + s * 0.42);
      ctx.lineTo(x + s * 0.08, y + s * 0.42);
      ctx.stroke();
      break;
    }
    case 'marketing': { // megaphone
      ctx.beginPath();
      ctx.moveTo(x - s * 0.42, y - s * 0.14);
      ctx.lineTo(x + s * 0.08, y - s * 0.4);
      ctx.lineTo(x + s * 0.08, y + s * 0.4);
      ctx.lineTo(x - s * 0.42, y + s * 0.14);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - s * 0.36, y + s * 0.12, s * 0.16, s * 0.26);
      ctx.beginPath();
      ctx.arc(x + s * 0.12, y, s * 0.28, -0.55, 0.55);
      ctx.moveTo(x + s * 0.12 + s * 0.42 * Math.cos(-0.5), y + s * 0.42 * Math.sin(-0.5));
      ctx.arc(x + s * 0.12, y, s * 0.42, -0.5, 0.5);
      ctx.stroke();
      break;
    }
    case 'finance': { // calculator
      fillRR(ctx, x - s * 0.32, y - s * 0.44, s * 0.64, s * 0.88, s * 0.08, color);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(x - s * 0.24, y - s * 0.36, s * 0.48, s * 0.18);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          circle(ctx, x - s * 0.18 + c * s * 0.18, y - s * 0.04 + r * s * 0.16, s * 0.05, '#FFFFFF');
        }
      }
      break;
    }
    case 'rnd': { // flask
      ctx.beginPath();
      ctx.moveTo(x - s * 0.12, y - s * 0.44);
      ctx.lineTo(x - s * 0.12, y - s * 0.1);
      ctx.lineTo(x - s * 0.42, y + s * 0.34);
      ctx.quadraticCurveTo(x - s * 0.46, y + s * 0.46, x - s * 0.3, y + s * 0.46);
      ctx.lineTo(x + s * 0.3, y + s * 0.46);
      ctx.quadraticCurveTo(x + s * 0.46, y + s * 0.46, x + s * 0.42, y + s * 0.34);
      ctx.lineTo(x + s * 0.12, y - s * 0.1);
      ctx.lineTo(x + s * 0.12, y - s * 0.44);
      ctx.closePath();
      ctx.globalAlpha *= 0.35;
      ctx.fill();
      ctx.globalAlpha /= 0.35;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - s * 0.2, y - s * 0.44);
      ctx.lineTo(x + s * 0.2, y - s * 0.44);
      ctx.stroke();
      circle(ctx, x - s * 0.08, y + s * 0.24, s * 0.05, color);
      circle(ctx, x + s * 0.12, y + s * 0.14, s * 0.04, color);
      break;
    }
    case 'lobby': { // bell
      ctx.beginPath();
      ctx.arc(x, y + s * 0.1, s * 0.36, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(x - s * 0.44, y + s * 0.08, s * 0.88, s * 0.1);
      circle(ctx, x, y + s * 0.3, s * 0.07, color);
      circle(ctx, x, y - s * 0.32, s * 0.08, color);
      break;
    }
    case 'garage': { // box
      fillRR(ctx, x - s * 0.4, y - s * 0.3, s * 0.8, s * 0.72, s * 0.06, color);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath();
      ctx.moveTo(x, y - s * 0.3);
      ctx.lineTo(x, y + s * 0.42);
      ctx.moveTo(x - s * 0.4, y - s * 0.08);
      ctx.lineTo(x + s * 0.4, y - s * 0.08);
      ctx.stroke();
      break;
    }
    case 'demo': { // screen
      fillRR(ctx, x - s * 0.44, y - s * 0.38, s * 0.88, s * 0.58, s * 0.08, color);
      ctx.fillRect(x - s * 0.06, y + s * 0.2, s * 0.12, s * 0.12);
      ctx.fillRect(x - s * 0.24, y + s * 0.3, s * 0.48, s * 0.08);
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(x - s * 0.1, y - s * 0.24);
      ctx.lineTo(x + s * 0.16, y - s * 0.09);
      ctx.lineTo(x - s * 0.1, y + s * 0.06);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }
}
