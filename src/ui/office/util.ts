/**
 * Small pure helpers for the office renderer: easing, hashing, money formatting.
 * No DOM and no sim imports, so the unit tests can import it under node.
 */
export interface Pt {
  x: number;
  y: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

export function easeInOutQuad(t: number): number {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) ** 2) / 2;
}

export function easeOutBack(t: number): number {
  const u = clamp(t, 0, 1) - 1;
  return 1 + 2.70158 * u * u * u + 1.70158 * u * u;
}

/** FNV-1a hash of a string mixed with a salt, mapped to [0, 1). Cosmetic variety without Math.random. */
export function hash01(text: string, salt = 0): number {
  let h = (2166136261 ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Hash of two small integers to [0, 1); used for particle systems so nothing is stored per particle. */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** $300, $1.5k, $30k, $184k, $1.2M: the short money format used on the floor. */
export function formatMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a < 999.5) return `${sign}$${Math.round(a)}`;
  if (a < 999_500) return `${sign}$${short(a / 1e3)}k`;
  return `${sign}$${short(a / 1e6)}M`;
}

function short(v: number): string {
  const s = v < 9.95 ? v.toFixed(1) : Math.round(v).toString();
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
