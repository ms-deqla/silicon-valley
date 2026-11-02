/**
 * Canvas 2D primitives shared by the painter: rounded rects, soft shadows, the
 * big-headed figure and the room glyphs drawn with paths (no images, no fonts
 * beyond the system stack). Pure drawing calls, no state.
 * DESIGN.md section 3: rounded, pastel, soft shadows, head ≈ 45% of a figure.
 */
import type { RoomKind } from '../../sim/types';

export type Ctx = CanvasRenderingContext2D;

export const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const EYE = '#2B2B33';
const SMILE = 'rgba(70,40,40,0.45)';

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

/**
 * The big-headed figure. (x, y) is the feet position, h the full height; the head
 * is ≈ 45% of h. `bob` shifts everything but the ground shadow, `walk` is the
 * walk-cycle phase (0 when standing), `dir` the facing direction (±1).
 */
export function drawFigure(
  ctx: Ctx, x: number, y: number, h: number, body: string, skin: string, hair: string,
  bob: number, walk: number, seated: boolean, alpha: number, dir: number,
): void {
  const headR = h * 0.225;
  const bodyW = h * 0.46;
  const bodyH = seated ? h * 0.36 : h * 0.5;
  const bodyTop = y - h * 0.56 + bob;
  if (alpha < 1) ctx.globalAlpha = Math.max(0, alpha);
  if (!seated) {
    ellipse(ctx, x, y + h * 0.015, bodyW * 0.62, h * 0.06, 'rgba(30,30,50,0.16)');
    const sw = Math.sin(walk) * h * 0.07;
    circle(ctx, x - bodyW * 0.24, y - h * 0.045 + sw * 0.5, h * 0.065, hair);
    circle(ctx, x + bodyW * 0.24, y - h * 0.045 - sw * 0.5, h * 0.065, hair);
  }
  fillRR(ctx, x - bodyW / 2, bodyTop, bodyW, bodyH, bodyW * 0.32, body);
  const hy = bodyTop - headR * 0.72;
  circle(ctx, x, hy - headR * 0.12, headR, hair);
  circle(ctx, x, hy + headR * 0.1, headR * 0.92, skin);
  const ex = headR * 0.3;
  const ey = hy + headR * 0.14;
  const off = dir * headR * 0.1;
  circle(ctx, x - ex + off, ey, headR * 0.09, EYE);
  circle(ctx, x + ex + off, ey, headR * 0.09, EYE);
  ctx.beginPath();
  ctx.arc(x + off, ey + headR * 0.26, headR * 0.22, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.strokeStyle = SMILE;
  ctx.lineWidth = Math.max(0.8, headR * 0.08);
  ctx.stroke();
  if (alpha < 1) ctx.globalAlpha = 1;
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
