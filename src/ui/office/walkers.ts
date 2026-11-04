/**
 * The crowd: walking figures and the small effects (coin popups, invoice slips,
 * puffs, confetti, glows, flashes, sweeps, pops). Pure data plus stepping, no DOM;
 * the painter draws it. Pools are allocated once; nothing is allocated per frame.
 * DESIGN.md section 13: up to CONFIG.ui.maxWalkers figures, beyond that an
 * existing figure carries a "×N" badge. Speed is pixels per second from wall-clock
 * dt, independent of the sim speed.
 */
import type { Layout } from './layout';
import { HAIR, SKIN, TROUSERS } from './palette';
import { CARRY_NONE, HAIR_STYLES, OUTFITS, WALK_FRAMES } from './primitives';
import type { Carry, Look } from './primitives';
import { formatMoney, hash01 } from './util';

export type WalkerKind = 'smb' | 'enterprise' | 'left' | 'waiting' | 'churn' | 'hire' | 'leave';
export type Act = 'none' | 'coin' | 'slip' | 'puff';

export interface Waypoint {
  x: number;
  y: number;
  /** seconds to linger on arrival; Infinity = stand forever (waiting prospects) */
  wait: number;
  /** fired when the linger ends */
  act: Act;
  /** target of the act (the slip flies here) */
  tx: number;
  ty: number;
}

export function wp(x: number, y: number, wait = 0, act: Act = 'none', tx = 0, ty = 0): Waypoint {
  return { x, y, wait, act, tx, ty };
}

export interface Walker {
  active: boolean;
  kind: WalkerKind;
  x: number;
  y: number;
  path: Waypoint[];
  idx: number;
  waitLeft: number;
  /** px per second */
  speed: number;
  /** 1 = no badge; N ≥ 2 draws "×N" */
  badge: number;
  badgeText: string;
  badgeW: number;
  age: number;
  phase: number;
  /** distance walked, drives the walk cycle */
  dist: number;
  moving: boolean;
  dir: 1 | -1;
  personId: string | null;
  body: string;
  skin: number;
  hair: number;
  /** the figure's look (body colour, skin, hair, outfit, hairstyle, what it carries); one object per slot, set at spawn */
  look: Look;
  alpha: number;
  coinAmount: number;
}

export type EffectType = 'coin' | 'slip' | 'puff' | 'confetti' | 'glow' | 'flash' | 'sweep' | 'pop';

export interface Effect {
  active: boolean;
  type: EffectType;
  t: number;
  dur: number;
  x: number;
  y: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  text: string;
  /** measured by the painter on first use; -1 until then */
  textW: number;
  color: string;
  seed: number;
  day: number;
  source: string;
  amount: number;
}

export interface Crowd {
  max: number;
  walkers: Walker[];
  effects: Effect[];
  /** running spawn counter, the seed for cosmetic variety */
  spawned: number;
  /** current cell size; new walkers take their speed from it */
  cell: number;
}

/** steady walking speed in cells per second (px/s = × cell) */
export const WALK_CELLS_PER_SEC = 1.5;
/** distance one walk cycle (WALK_FRAMES frames) covers, in cells */
export const WALK_CYCLE_CELLS = 0.8;
export const EFFECT_POOL = 48;
/** seconds within which coin popups of the same source and day merge into one */
export const COIN_MERGE_WINDOW = 0.5;

export const DUR: Record<EffectType, number> = {
  coin: 1.4,
  slip: 0.95,
  puff: 0.7,
  confetti: 1.7,
  glow: 1.3,
  flash: 1.0,
  sweep: 0.9,
  pop: 0.6,
};

function blankWalker(): Walker {
  return {
    active: false, kind: 'smb', x: 0, y: 0, path: [], idx: 0, waitLeft: 0, speed: 0,
    badge: 1, badgeText: '', badgeW: -1, age: 0, phase: 0, dist: 0, moving: false, dir: 1,
    personId: null, body: '#000', skin: 0, hair: 0,
    look: { body: '#000', skin: SKIN[0], hair: HAIR[0], trousers: TROUSERS[0], outfit: 0, style: 0, carry: CARRY_NONE },
    alpha: 1, coinAmount: 0,
  };
}

function blankEffect(): Effect {
  return {
    active: false, type: 'pop', t: 0, dur: 1, x: 0, y: 0, x2: 0, y2: 0, w: 0, h: 0,
    text: '', textW: -1, color: '#fff', seed: 0, day: -1, source: '', amount: 0,
  };
}

export function createCrowd(max: number, cell = 1): Crowd {
  const walkers: Walker[] = [];
  for (let i = 0; i < Math.max(1, max); i++) walkers.push(blankWalker());
  const effects: Effect[] = [];
  for (let i = 0; i < EFFECT_POOL; i++) effects.push(blankEffect());
  return { max: Math.max(1, max), walkers, effects, spawned: 0, cell };
}

export function resetCrowd(crowd: Crowd): void {
  for (const w of crowd.walkers) w.active = false;
  for (const e of crowd.effects) e.active = false;
}

export function activeWalkers(crowd: Crowd): number {
  let n = 0;
  for (const w of crowd.walkers) if (w.active) n++;
  return n;
}

export function countKind(crowd: Crowd, kind: WalkerKind): number {
  let n = 0;
  for (const w of crowd.walkers) if (w.active && w.kind === kind) n++;
  return n;
}

export function findWalker(crowd: Crowd, kind: WalkerKind): Walker | null {
  for (const w of crowd.walkers) if (w.active && w.kind === kind) return w;
  return null;
}

/** The walk-cycle frame of a walker (0..WALK_FRAMES−1 from the distance walked), or −1 when it stands. */
export function walkFrame(w: Walker, cell: number): number {
  if (!w.moving || !(cell > 0)) return -1;
  return Math.floor((w.dist / (WALK_CYCLE_CELLS * cell)) * WALK_FRAMES) % WALK_FRAMES;
}

/** Sum of badges: how many figures the crowd stands for. */
export function representedWalkers(crowd: Crowd): number {
  let n = 0;
  for (const w of crowd.walkers) if (w.active) n += w.badge;
  return n;
}

export interface SpawnOpts {
  body: string;
  personId?: string | null;
  skin?: number;
  hair?: number;
  /** outfit, hairstyle and trousers indices; hashed from the spawn counter when omitted */
  outfit?: number;
  style?: number;
  trousers?: number;
  carry?: Carry;
  alpha?: number;
  coinAmount?: number;
}

/** Put a "×N" badge on an existing walker (same kind preferred, lowest badge first). */
export function badgeWalker(crowd: Crowd, kind: WalkerKind): Walker | null {
  let best: Walker | null = null;
  for (const w of crowd.walkers) {
    if (!w.active) continue;
    if (!best) { best = w; continue; }
    const sameBest = best.kind === kind;
    const sameW = w.kind === kind;
    if (sameW !== sameBest) { if (sameW) best = w; continue; }
    if (w.badge < best.badge) best = w;
  }
  if (!best) return null;
  best.badge += 1;
  best.badgeText = `×${best.badge}`;
  best.badgeW = -1;
  return best;
}

/**
 * Spawn a walker on a path. When every slot is alive, an existing walker gets a
 * "×N" badge instead and null is returned (DESIGN 13).
 */
export function spawnWalker(crowd: Crowd, kind: WalkerKind, path: Waypoint[], opts: SpawnOpts): Walker | null {
  if (path.length === 0) return null;
  let slot: Walker | null = null;
  for (const w of crowd.walkers) if (!w.active) { slot = w; break; }
  if (!slot) {
    badgeWalker(crowd, kind);
    return null;
  }
  const seed = String(crowd.spawned);
  slot.active = true;
  slot.kind = kind;
  slot.x = path[0].x;
  slot.y = path[0].y;
  slot.path = path;
  slot.idx = 0;
  slot.waitLeft = 0;
  slot.speed = WALK_CELLS_PER_SEC * crowd.cell;
  slot.badge = 1;
  slot.badgeText = '';
  slot.badgeW = -1;
  slot.age = 0;
  slot.phase = hash01(seed, 7) * Math.PI * 2;
  slot.dist = 0;
  slot.moving = false;
  slot.dir = path.length > 1 && path[1].x < path[0].x ? -1 : 1;
  slot.personId = opts.personId ?? null;
  slot.body = opts.body;
  slot.skin = opts.skin ?? Math.floor(hash01(seed, 1) * SKIN.length);
  slot.hair = opts.hair ?? Math.floor(hash01(seed, 2) * HAIR.length);
  const look = slot.look;
  look.body = opts.body;
  look.skin = SKIN[slot.skin];
  look.hair = HAIR[slot.hair];
  const trousers = opts.trousers ?? -1;
  look.trousers = TROUSERS[trousers >= 0 && trousers < TROUSERS.length ? trousers : Math.floor(hash01(seed, 6) * TROUSERS.length)];
  look.outfit = opts.outfit ?? Math.floor(hash01(seed, 4) * OUTFITS);
  look.style = opts.style ?? Math.floor(hash01(seed, 5) * HAIR_STYLES);
  look.carry = opts.carry ?? CARRY_NONE;
  slot.alpha = opts.alpha ?? 1;
  slot.coinAmount = opts.coinAmount ?? 0;
  crowd.spawned += 1;
  return slot;
}

/** Re-purpose a live walker (a waiting prospect becomes the enterprise visitor or the one who left). */
export function retargetWalker(w: Walker, kind: WalkerKind, path: Waypoint[], opts: Partial<SpawnOpts> = {}): void {
  if (path.length === 0) { w.active = false; return; }
  w.kind = kind;
  w.path = path;
  w.idx = 0;
  w.waitLeft = 0;
  w.moving = false;
  if (opts.body) {
    w.body = opts.body;
    w.look.body = opts.body;
  }
  if (opts.carry !== undefined) w.look.carry = opts.carry;
  if (opts.alpha !== undefined) w.alpha = opts.alpha;
  if (opts.coinAmount !== undefined) w.coinAmount = opts.coinAmount;
  if (opts.personId !== undefined) w.personId = opts.personId;
}

export interface EffectOpts {
  x2?: number;
  y2?: number;
  w?: number;
  h?: number;
  text?: string;
  color?: string;
  seed?: number;
  day?: number;
  source?: string;
  amount?: number;
}

export function spawnEffect(crowd: Crowd, type: EffectType, x: number, y: number, opts: EffectOpts = {}): Effect {
  let slot: Effect | null = null;
  let oldest: Effect = crowd.effects[0];
  let oldestP = -1;
  for (const e of crowd.effects) {
    if (!e.active) { slot = e; break; }
    const p = e.t / e.dur;
    if (p > oldestP) { oldestP = p; oldest = e; }
  }
  const e = slot ?? oldest;
  e.active = true;
  e.type = type;
  e.t = 0;
  e.dur = DUR[type];
  e.x = x;
  e.y = y;
  e.x2 = opts.x2 ?? x;
  e.y2 = opts.y2 ?? y;
  e.w = opts.w ?? 0;
  e.h = opts.h ?? 0;
  e.text = opts.text ?? '';
  e.textW = -1;
  e.color = opts.color ?? '#FFFFFF';
  e.seed = opts.seed ?? crowd.spawned;
  e.day = opts.day ?? -1;
  e.source = opts.source ?? '';
  e.amount = opts.amount ?? 0;
  return e;
}

/** A "+$X" popup; popups of the same source and day within the merge window add up (DESIGN 13). */
export function coinAt(crowd: Crowd, x: number, y: number, amount: number, day: number, source: string): Effect {
  for (const e of crowd.effects) {
    if (e.active && e.type === 'coin' && e.source === source && e.day === day && e.t < COIN_MERGE_WINDOW) {
      e.amount += amount;
      e.text = '+' + formatMoney(e.amount);
      e.textW = -1;
      e.t = Math.min(e.t, 0.12);
      return e;
    }
  }
  return spawnEffect(crowd, 'coin', x, y, { text: '+' + formatMoney(amount), amount, day, source });
}

function fireAct(crowd: Crowd, w: Walker, p: Waypoint): void {
  const c = crowd.cell;
  switch (p.act) {
    case 'coin':
      coinAt(crowd, w.x, w.y - 0.8 * c, w.coinAmount, -1, 'visitor');
      break;
    case 'slip':
      spawnEffect(crowd, 'slip', w.x, w.y - 0.5 * c, { x2: p.tx, y2: p.ty, seed: crowd.spawned });
      break;
    case 'puff':
      spawnEffect(crowd, 'puff', w.x, w.y - 0.3 * c, { seed: crowd.spawned });
      break;
    case 'none':
      break;
  }
}

/**
 * Advance walkers along their paths and age the effects. dt in seconds.
 * A frame's time is consumed continuously: arriving at a waypoint with no wait
 * spends none of it, so a walker covers speed × dt regardless of how dt is sliced.
 */
export function stepCrowd(crowd: Crowd, dt: number): void {
  if (!(dt > 0)) return;
  for (const w of crowd.walkers) {
    if (!w.active) continue;
    w.age += dt;
    let remaining = dt;
    while (remaining > 0 && w.active) {
      if (w.waitLeft > 0) {
        const used = Math.min(w.waitLeft, remaining);
        w.waitLeft -= used;
        remaining -= used;
        w.moving = false;
        if (w.waitLeft > 0) break;
        fireAct(crowd, w, w.path[w.idx]);
        w.idx += 1;
        if (w.idx >= w.path.length) w.active = false;
        continue;
      }
      const target = w.path[w.idx];
      const dx = target.x - w.x;
      const dy = target.y - w.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const step = w.speed * remaining;
      if (d <= step) {
        w.x = target.x;
        w.y = target.y;
        w.dist += d;
        remaining -= w.speed > 0 ? d / w.speed : remaining;
        w.moving = false;
        if (target.wait > 0) {
          w.waitLeft = target.wait;
        } else {
          fireAct(crowd, w, target);
          w.idx += 1;
          if (w.idx >= w.path.length) w.active = false;
        }
      } else {
        const k = step / d;
        w.x += dx * k;
        w.y += dy * k;
        w.dist += step;
        w.moving = true;
        if (Math.abs(dx) > 0.01) w.dir = dx < 0 ? -1 : 1;
        remaining = 0;
      }
    }
  }
  for (const e of crowd.effects) {
    if (!e.active) continue;
    e.t += dt;
    if (e.t >= e.dur) e.active = false;
  }
}

/**
 * Map everything alive from one layout to another (resize, second floor bought).
 * Positions are kept relative to floor 0's top-left so floor-0 figures stay on
 * floor 0 when a floor is inserted above it.
 */
export function rescaleCrowd(crowd: Crowd, from: Layout, to: Layout): void {
  crowd.cell = to.cell;
  if (!(from.cell > 0) || !(to.cell > 0)) { resetCrowd(crowd); return; }
  const k = to.cell / from.cell;
  const fx = from.x0;
  const fy = from.floorTop[0];
  const tx = to.x0;
  const ty = to.floorTop[0];
  const mx = (x: number): number => tx + (x - fx) * k;
  const my = (y: number): number => ty + (y - fy) * k;
  for (const w of crowd.walkers) {
    if (!w.active) continue;
    w.x = mx(w.x);
    w.y = my(w.y);
    w.speed *= k;
    w.dist *= k;
    for (const p of w.path) {
      p.x = mx(p.x);
      p.y = my(p.y);
      p.tx = mx(p.tx);
      p.ty = my(p.ty);
    }
  }
  for (const e of crowd.effects) {
    if (!e.active) continue;
    e.x = mx(e.x);
    e.y = my(e.y);
    e.x2 = mx(e.x2);
    e.y2 = my(e.y2);
    e.w *= k;
    e.h *= k;
    e.textW = -1;
  }
}
