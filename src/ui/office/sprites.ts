/**
 * Offscreen sprite cache: a figure, desk or chair is drawn once into a small
 * canvas at the backing-store scale and blitted afterwards, so a floor with a
 * hundred seated people costs a hundred drawImage calls, not a hundred figure
 * paths. Keys carry the look, not the person, so two look-alikes share a sprite.
 * Without a DOM (unit tests) the cache is disabled and callers draw directly.
 */
import type { Ctx } from './primitives';

export interface Sprite {
  cv: HTMLCanvasElement;
  /** CSS px size and the anchor (the point drawSprite places at x, y) */
  w: number;
  h: number;
  ox: number;
  oy: number;
}

export interface SpriteCache {
  map: Map<string, Sprite>;
  /** the cell size and backing scale the sprites were drawn for; a change empties the cache */
  cell: number;
  scale: number;
  enabled: boolean;
}

/** more sprites than this (a very long run with many looks) and the cache starts over */
export const SPRITE_CAP = 800;

export function createSpriteCache(): SpriteCache {
  const enabled = typeof document !== 'undefined' && typeof document.createElement === 'function';
  return { map: new Map(), cell: 0, scale: 1, enabled };
}

/** Sprites are drawn for one cell size and one backing scale; call when either changes. */
export function resetSpriteCache(cache: SpriteCache, cell: number, scale: number): void {
  if (cache.cell === cell && cache.scale === scale) return;
  cache.map.clear();
  cache.cell = cell;
  cache.scale = scale > 0 ? scale : 1;
}

export function clearSprites(cache: SpriteCache): void {
  cache.map.clear();
}

/**
 * The sprite under `key`, drawn on first use by `paint(ctx, arg, ox, oy)` into a
 * w×h CSS px box whose anchor is at (ox, oy). Returns null when sprites are
 * unavailable (no DOM), in which case the caller draws directly.
 */
export function getSprite<T>(
  cache: SpriteCache, key: string, w: number, h: number, ox: number, oy: number,
  paint: (ctx: Ctx, arg: T, ox: number, oy: number) => void, arg: T,
): Sprite | null {
  if (!cache.enabled) return null;
  const hit = cache.map.get(key);
  if (hit) return hit;
  if (cache.map.size >= SPRITE_CAP) cache.map.clear();
  let cv: HTMLCanvasElement;
  let g: Ctx | null;
  try {
    cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil(w * cache.scale));
    cv.height = Math.max(1, Math.ceil(h * cache.scale));
    g = cv.getContext('2d');
  } catch {
    g = null;
    cv = null as unknown as HTMLCanvasElement;
  }
  if (!g) {
    cache.enabled = false;
    return null;
  }
  g.setTransform(cache.scale, 0, 0, cache.scale, 0, 0);
  paint(g, arg, ox, oy);
  const s: Sprite = { cv, w, h, ox, oy };
  cache.map.set(key, s);
  return s;
}

export function drawSprite(ctx: Ctx, s: Sprite, x: number, y: number): void {
  ctx.drawImage(s.cv, x - s.ox, y - s.oy, s.w, s.h);
}
