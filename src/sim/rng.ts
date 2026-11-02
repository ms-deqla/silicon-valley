/**
 * Seeded PRNG (sfc32). State lives in GameState.rng so a run is replayable.
 * Every random decision in the sim goes through these helpers.
 */
import type { RngState } from './types';

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

/** Build an RNG state from any integer seed. */
export function seedRng(seed: number): RngState {
  const sm = splitmix32(seed | 0);
  const s: RngState = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) s[i] = (sm() * 4294967296) >>> 0;
  // warm up
  for (let i = 0; i < 12; i++) rand(s);
  return s;
}

/** Uniform in [0, 1). Mutates the state. */
export function rand(s: RngState): number {
  let [a, b, c, d] = s;
  a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s[0] = a; s[1] = b; s[2] = c; s[3] = d;
  return (t >>> 0) / 4294967296;
}

/** Integer in [lo, hi] inclusive. */
export function randInt(s: RngState, lo: number, hi: number): number {
  return lo + Math.floor(rand(s) * (hi - lo + 1));
}

/** Float in [lo, hi). */
export function randRange(s: RngState, lo: number, hi: number): number {
  return lo + rand(s) * (hi - lo);
}

export function chance(s: RngState, p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return rand(s) < p;
}

export function pick<T>(s: RngState, arr: readonly T[]): T {
  return arr[Math.floor(rand(s) * arr.length)];
}

/** Weighted pick; weights need not sum to 1. */
export function pickWeighted<T>(s: RngState, items: readonly T[], weights: readonly number[]): T {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  let x = rand(s) * total;
  for (let i = 0; i < items.length; i++) {
    x -= Math.max(0, weights[i]);
    if (x < 0) return items[i];
  }
  return items[items.length - 1];
}

/** Poisson sample; Knuth for small lambda, normal approximation above 30. */
export function poisson(s: RngState, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    const n = Math.round(lambda + Math.sqrt(lambda) * normal(s));
    return Math.max(0, n);
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand(s);
  } while (p > L);
  return k - 1;
}

/** Standard normal via Box–Muller. */
export function normal(s: RngState): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand(s);
  while (v === 0) v = rand(s);
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Seed from a YYYYMMDD date so everyone gets the same world on the same day. */
export function dailySeed(date: Date = new Date()): number {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** Stable 32-bit hash of a string, for custom seeds typed by the player. */
export function hashSeed(text: string): number {
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10) | 0;
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
