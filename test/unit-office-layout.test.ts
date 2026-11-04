/**
 * Office renderer geometry and crowd maths, exercised without a DOM: layout
 * (cell size, floor offsets, room rects, hit-testing), the scene cache, money
 * formatting, the walker pool (cap, ×N badges, steady speed) and the
 * choreography of visual events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG, OK, createGame } from '../src/sim';
import type { Action, GameState, Room, VisualEvent } from '../src/sim';
import type { GameController, PlacementMode } from '../src/ui/api';
import { LOT_PAD, createOfficeRenderer } from '../src/ui/renderer';
import {
  BACK_WALL, GAP_ROWS, STREET_ROWS, cellRect, computeLayout, doorAnchor, floorRect, footprint, hitCell, layout,
  roomAt, roomRect, stairPoints,
} from '../src/ui/office/layout';
import { buildPlots, buildScene, lookKey, lookOf } from '../src/ui/office/scene';
import { formatMoney, hash01 } from '../src/ui/office/util';
import {
  WALK_CELLS_PER_SEC, WALK_CYCLE_CELLS, activeWalkers, coinAt, countKind, createCrowd, representedWalkers, rescaleCrowd,
  spawnWalker, stepCrowd, walkFrame, wp,
} from '../src/ui/office/walkers';
import { MAX_WAITING, applyVisual } from '../src/ui/office/choreo';
import type { ChoreoContext } from '../src/ui/office/choreo';
import { CARRY_BAG, CARRY_BOX, CARRY_CASE, CARRY_LAPTOP, CARRY_NONE, HAIR_STYLES, OUTFITS, WALK_FRAMES } from '../src/ui/office/primitives';
import { HAIR, SKIN, TROUSERS, shades } from '../src/ui/office/palette';
import { createSpriteCache, getSprite, resetSpriteCache } from '../src/ui/office/sprites';
import { BUS_CROSS, BUS_PERIOD, busDir, busProgress, busX } from '../src/ui/office/street';
import { RULES } from '../src/sim/config';
import { validSpots } from '../src/sim/rooms';

const near = (a: number, b: number, eps = 1e-6): void => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('layout', () => {
  it('fits one floor plus the street into a portrait canvas, centred', () => {
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    const rows = CONFIG.grid.h + STREET_ROWS;
    expect(l.rows).toBe(rows);
    near(l.cell, Math.min(420 / CONFIG.grid.w, 560 / rows));
    near(l.cell, 560 / 9.5);
    near(l.lotW, CONFIG.grid.w * l.cell);
    near(l.lotH, rows * l.cell);
    near(l.x0, (420 - l.lotW) / 2);
    near(l.y0, 0);
    expect(l.floorTop).toEqual([l.y0]);
    near(l.streetTop, l.y0 + CONFIG.grid.h * l.cell);
    near(l.streetH, STREET_ROWS * l.cell);
    expect(l.gapH).toBe(0);
    expect(l.stair).toBeNull();
    expect(layout).toBe(computeLayout);
  });

  it('is width-bound on a tall canvas and centres vertically', () => {
    const l = computeLayout({ width: 200, height: 2000, floors: 1 });
    near(l.cell, 200 / CONFIG.grid.w);
    near(l.x0, 0);
    near(l.y0, (2000 - l.lotH) / 2);
  });

  it('honours the pad', () => {
    const a = computeLayout({ width: 420, height: 560, floors: 1 });
    const b = computeLayout({ width: 420, height: 560, floors: 1, pad: 10 });
    near(b.cell, (560 - 20) / a.rows);
    expect(b.cell).toBeLessThan(a.cell);
    near(b.y0, 10);
  });

  it('stacks floor 1 above floor 0 with a staircase gap', () => {
    const l = computeLayout({ width: 420, height: 560, floors: 2 });
    const rows = CONFIG.grid.h * 2 + STREET_ROWS + GAP_ROWS;
    expect(l.rows).toBe(rows);
    near(l.cell, 560 / rows);
    expect(l.floorTop.length).toBe(2);
    near(l.floorTop[1], l.y0);
    near(l.gapTop, l.y0 + CONFIG.grid.h * l.cell);
    near(l.gapH, GAP_ROWS * l.cell);
    near(l.floorTop[0], l.gapTop + l.gapH);
    expect(l.floorTop[1]).toBeLessThan(l.floorTop[0]);
    near(l.streetTop, l.floorTop[0] + CONFIG.grid.h * l.cell);
    near(l.streetTop + l.streetH, l.y0 + l.lotH);
    expect(l.stair).not.toBeNull();
    near(l.stair!.y, l.gapTop);
    near(l.stair!.h, l.gapH);
    expect(l.stair!.x).toBeGreaterThan(l.x0);
    expect(l.stair!.x + l.stair!.w).toBeLessThanOrEqual(l.x0 + l.lotW + 1e-9);
    const sp = stairPoints(l)!;
    expect(sp.bottom.y).toBeGreaterThan(l.floorTop[0]);
    expect(sp.top.y).toBeLessThan(l.gapTop);
  });

  it('survives a zero-sized canvas', () => {
    const l = computeLayout({ width: 0, height: 0, floors: 1 });
    expect(l.cell).toBe(0);
    expect(hitCell(l, 0, 0)).toBeNull();
  });

  it('places room rects on the right floor', () => {
    const l = computeLayout({ width: 420, height: 560, floors: 2 });
    const g = CONFIG.grid.garage;
    const garage: Room = { id: 'garage', kind: 'garage', size: 'small', floor: 0, x: g.x, y: g.y, w: g.w, h: g.h, rent: 0, openedDay: 0 };
    const r = roomRect(l, garage);
    near(r.x, l.x0 + g.x * l.cell);
    near(r.y, l.floorTop[0] + g.y * l.cell);
    near(r.w, g.w * l.cell);
    near(r.h, g.h * l.cell);
    const up: Room = { ...garage, id: 'r2', kind: 'sales', floor: 1, x: 1, y: 2, w: 3, h: 2 };
    const r2 = roomRect(l, up);
    near(r2.x, l.x0 + l.cell);
    near(r2.y, l.y0 + 2 * l.cell);
    near(r2.w, 3 * l.cell);
    const out = { x: 0, y: 0, w: 0, h: 0 };
    expect(roomRect(l, up, out)).toBe(out);
    const f1 = floorRect(l, 1);
    near(f1.y, l.y0);
    near(f1.h, CONFIG.grid.h * l.cell);
    const c = cellRect(l, 0, 5, 7);
    near(c.x + c.w, l.x0 + l.lotW);
    near(c.y + c.h, l.streetTop);
  });

  it('hit-tests cells per floor and nothing on the street, the gap or outside', () => {
    const l = computeLayout({ width: 420, height: 560, floors: 2 });
    const c = l.cell;
    expect(hitCell(l, l.x0 + 0.5 * c, l.floorTop[0] + 7.5 * c)).toEqual({ floor: 0, x: 0, y: 7 });
    expect(hitCell(l, l.x0 + 5.9 * c, l.floorTop[0] + 0.1 * c)).toEqual({ floor: 0, x: 5, y: 0 });
    expect(hitCell(l, l.x0 + 2.5 * c, l.y0 + 3.5 * c)).toEqual({ floor: 1, x: 2, y: 3 });
    expect(hitCell(l, l.x0 + 2.5 * c, l.streetTop + 0.5 * c)).toBeNull();
    expect(hitCell(l, l.x0 + 2.5 * c, l.gapTop + 0.3 * c)).toBeNull();
    expect(hitCell(l, l.x0 - 1, l.floorTop[0] + 0.5 * c)).toBeNull();
    expect(hitCell(l, l.x0 + l.lotW, l.floorTop[0] + 0.5 * c)).toBeNull();
    expect(hitCell(l, l.x0 + 1, l.y0 - 1)).toBeNull();
    // the very last pixel of the floor still maps to the last cell
    expect(hitCell(l, l.x0 + l.lotW - 0.001, l.streetTop - 0.001)).toEqual({ floor: 0, x: 5, y: 7 });
  });

  it('finds the room under a cell', () => {
    const s = createGame(1);
    expect(roomAt(s.rooms, 0, 0, 7)?.id).toBe('garage');
    expect(roomAt(s.rooms, 0, 1, 6)?.id).toBe('garage');
    expect(roomAt(s.rooms, 0, 2, 6)).toBeUndefined();
    expect(roomAt(s.rooms, 1, 0, 7)).toBeUndefined();
  });

  it('puts the door on the lobby, or on the garage before the lobby exists', () => {
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    const g = CONFIG.grid.garage;
    const lb = CONFIG.grid.lobby;
    const dg = doorAnchor(l, false);
    near(dg.x, l.x0 + (g.x + g.w / 2) * l.cell);
    near(dg.y, l.floorTop[0] + (g.y + g.h) * l.cell);
    const dl = doorAnchor(l, true);
    near(dl.x, l.x0 + (lb.x + lb.w / 2) * l.cell);
    near(dl.y, l.streetTop);
  });

  it('takes footprints from CONFIG', () => {
    expect(footprint('sales', 'small')).toEqual({ w: CONFIG.rooms.size.small.w, h: CONFIG.rooms.size.small.h });
    expect(footprint('sales', 'large')).toEqual({ w: CONFIG.rooms.size.large.w, h: CONFIG.rooms.size.large.h });
    expect(footprint('demo', 'large')).toEqual({ w: CONFIG.rooms.demo.w, h: CONFIG.rooms.demo.h });
  });
});

describe('scene', () => {
  it('seats the founder at the garage desk and routes through the garage door', () => {
    const s = createGame(7);
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    const sc = buildScene(s, l);
    expect(sc.hasLobby).toBe(false);
    expect(sc.lobby).toBeNull();
    const garage = sc.first.garage!;
    expect(garage.slots.length).toBe(CONFIG.rooms.garage.maxDesks);
    expect(garage.deskCount).toBe(1);
    expect(garage.seats.length).toBe(1);
    expect(garage.seats[0].founder).toBe(true);
    expect(garage.seats[0].role).toBe('product');
    expect(sc.seats.get(garage.seats[0].personId)).toBe(garage.seats[0]);
    // desks and seats stay inside the room, below the back wall
    for (const p of garage.slots) {
      expect(p.x).toBeGreaterThan(garage.rect.x);
      expect(p.x).toBeLessThan(garage.rect.x + garage.rect.w);
      expect(p.y).toBeGreaterThan(garage.rect.y + BACK_WALL * l.cell);
      expect(p.y).toBeLessThan(garage.rect.y + garage.rect.h);
    }
    near(sc.anchors.door.x, doorAnchor(l, false).x);
    expect(sc.anchors.lobbyPoint.y).toBeLessThan(garage.rect.y + garage.rect.h);
    expect(sc.anchors.stairBottom).toBeNull();
    expect(sc.floor1).toBeNull();
    expect(sc.servers).toBe(0);
    expect(sc.coffee).toBe(false);
  });

  it('switches the hall to the lobby once it exists and prefers floor-0 rooms', () => {
    const s = createGame(7);
    const lb = CONFIG.grid.lobby;
    s.rooms.push({ id: 'lobby', kind: 'lobby', size: 'small', floor: 0, x: lb.x, y: lb.y, w: lb.w, h: lb.h, rent: 0, openedDay: 0 });
    s.rooms.push({ id: 'p1', kind: 'product', size: 'small', floor: 1, x: 0, y: 0, w: 2, h: 2, rent: 3000, openedDay: 0 });
    s.rooms.push({ id: 'p0', kind: 'product', size: 'large', floor: 0, x: 0, y: 0, w: 3, h: 2, rent: 4500, openedDay: 0 });
    s.floors = 2;
    const l = computeLayout({ width: 420, height: 560, floors: 2 });
    const sc = buildScene(s, l);
    expect(sc.hasLobby).toBe(true);
    expect(sc.lobby).not.toBeNull();
    expect(sc.first.product!.room.id).toBe('p0');
    expect(sc.first.product!.slots.length).toBe(CONFIG.rooms.size.large.maxDesks);
    expect(sc.byId.get('p1')!.slots.length).toBe(CONFIG.rooms.size.small.maxDesks);
    near(sc.anchors.door.x, doorAnchor(l, true).x);
    expect(sc.anchors.stairBottom).not.toBeNull();
    expect(sc.floor1).not.toBeNull();
    const tray = sc.lobby!.tray;
    expect(tray.x).toBeGreaterThan(sc.hall.x);
    expect(tray.x + tray.w).toBeLessThan(sc.hall.x + sc.hall.w);
    expect(sc.lobby!.sign.x).toBeLessThanOrEqual(sc.hall.x + sc.hall.w);
  });
});

describe('formatMoney', () => {
  it('uses $, k and M', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(300)).toBe('$300');
    expect(formatMoney(999)).toBe('$999');
    expect(formatMoney(1000)).toBe('$1k');
    expect(formatMoney(1500)).toBe('$1.5k');
    expect(formatMoney(30000)).toBe('$30k');
    expect(formatMoney(184000)).toBe('$184k');
    expect(formatMoney(999_499)).toBe('$999k');
    expect(formatMoney(1_200_000)).toBe('$1.2M');
    expect(formatMoney(25_000_000)).toBe('$25M');
    expect(formatMoney(-4500)).toBe('-$4.5k');
  });

  it('hashes deterministically into [0, 1)', () => {
    expect(hash01('p3', 1)).toBe(hash01('p3', 1));
    expect(hash01('p3', 1)).not.toBe(hash01('p3', 2));
    for (let i = 0; i < 50; i++) {
      const v = hash01('x' + i, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('crowd', () => {
  const path = (): ReturnType<typeof wp>[] => [wp(0, 0), wp(100, 0), wp(100, 50, 0.5), wp(200, 50)];

  it('caps alive walkers at the pool size and badges the rest', () => {
    const crowd = createCrowd(CONFIG.ui.maxWalkers, 40);
    for (let i = 0; i < CONFIG.ui.maxWalkers + 3; i++) spawnWalker(crowd, 'smb', path(), { body: '#000' });
    expect(activeWalkers(crowd)).toBe(CONFIG.ui.maxWalkers);
    expect(representedWalkers(crowd)).toBe(CONFIG.ui.maxWalkers + 3);
    const badged = crowd.walkers.filter((w) => w.badge > 1);
    expect(badged.length).toBeGreaterThan(0);
    expect(badged[0].badgeText).toMatch(/^×\d+$/);
  });

  it('walks at a steady px/s regardless of how dt is sliced', () => {
    const a = createCrowd(4, 40);
    const b = createCrowd(4, 40);
    const wa = spawnWalker(a, 'smb', path(), { body: '#000' })!;
    const wb = spawnWalker(b, 'smb', path(), { body: '#000' })!;
    expect(wa.speed).toBe(WALK_CELLS_PER_SEC * 40);
    stepCrowd(a, 1);
    for (let i = 0; i < 10; i++) stepCrowd(b, 0.1);
    near(wa.x, 60, 1e-6);
    near(wa.x, wb.x, 1e-6);
    near(wa.y, 0);
    expect(wa.moving).toBe(true);
    expect(wa.dir).toBe(1);
  });

  it('lingers at a waypoint, finishes its path and frees the slot', () => {
    const crowd = createCrowd(2, 40);
    const w = spawnWalker(crowd, 'smb', path(), { body: '#000' })!;
    // 100 px to the corner, 50 px down (2.5 s at 60 px/s), 0.5 s wait, 100 px out: done after ≈ 4.67 s
    for (let i = 0; i < 28; i++) stepCrowd(crowd, 0.1);
    expect(w.active).toBe(true);
    near(w.x, 100);
    near(w.y, 50);
    expect(w.waitLeft).toBeGreaterThan(0);
    for (let i = 0; i < 25; i++) stepCrowd(crowd, 0.1);
    expect(w.active).toBe(false);
    expect(activeWalkers(crowd)).toBe(0);
  });

  it('keeps a waiting walker standing for ever', () => {
    const crowd = createCrowd(2, 40);
    const w = spawnWalker(crowd, 'waiting', [wp(0, 0), wp(10, 0, Infinity)], { body: '#000' })!;
    for (let i = 0; i < 200; i++) stepCrowd(crowd, 0.1);
    expect(w.active).toBe(true);
    near(w.x, 10);
    expect(w.moving).toBe(false);
  });

  it('fires the coin act when the linger ends and merges coins of one source', () => {
    const crowd = createCrowd(2, 40);
    spawnWalker(crowd, 'smb', [wp(0, 0), wp(10, 0, 0.2, 'coin')], { body: '#000', coinAmount: 300 });
    for (let i = 0; i < 6; i++) stepCrowd(crowd, 0.1);
    const coins = crowd.effects.filter((e) => e.active && e.type === 'coin');
    expect(coins.length).toBe(1);
    expect(coins[0].text).toBe('+$300');
    coinAt(crowd, 0, 0, 300, -1, 'visitor');
    expect(crowd.effects.filter((e) => e.active && e.type === 'coin').length).toBe(1);
    expect(coins[0].text).toBe('+$600');
    coinAt(crowd, 0, 0, 1000, 5, 'smb');
    expect(crowd.effects.filter((e) => e.active && e.type === 'coin').length).toBe(2);
  });

  it('rescales positions and speed relative to floor 0 when the layout changes', () => {
    const from = computeLayout({ width: 420, height: 560, floors: 1 });
    const to = computeLayout({ width: 420, height: 560, floors: 2 });
    const crowd = createCrowd(2, from.cell);
    const w = spawnWalker(crowd, 'smb', [wp(from.x0 + from.cell, from.floorTop[0] + 7 * from.cell), wp(from.x0 + 5 * from.cell, from.floorTop[0] + 7 * from.cell)], { body: '#000' })!;
    const speed0 = w.speed;
    rescaleCrowd(crowd, from, to);
    near(w.x, to.x0 + to.cell);
    near(w.y, to.floorTop[0] + 7 * to.cell);
    near(w.path[1].x, to.x0 + 5 * to.cell);
    near(w.speed, speed0 * (to.cell / from.cell));
    expect(crowd.cell).toBe(to.cell);
  });
});

describe('choreography', () => {
  function world(withRooms: boolean) {
    const s = createGame(11);
    if (withRooms) {
      const lb = CONFIG.grid.lobby;
      s.rooms.push({ id: 'lobby', kind: 'lobby', size: 'small', floor: 0, x: lb.x, y: lb.y, w: lb.w, h: lb.h, rent: 0, openedDay: 0 });
      s.rooms.push({ id: 'sales', kind: 'sales', size: 'small', floor: 0, x: 0, y: 0, w: 2, h: 2, rent: 3000, openedDay: 0 });
      s.rooms.push({ id: 'prod', kind: 'product', size: 'small', floor: 0, x: 3, y: 0, w: 2, h: 2, rent: 3000, openedDay: 0 });
    }
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    const scene = buildScene(s, l);
    const crowd = createCrowd(CONFIG.ui.maxWalkers, l.cell);
    const cx: ChoreoContext = {
      smbPrice: 300,
      seatOf: (id) => scene.seats.get(id) ?? null,
      lastSeatOf: (id) => scene.seats.get(id) ?? null,
      lastRoomCentre: () => null,
      assetPoint: () => null,
    };
    return { s, l, scene, crowd, cx };
  }

  it('sends an smb visitor through the product room to reception and out', () => {
    const { scene, crowd, cx } = world(true);
    const ev: VisualEvent = { t: 'visitor', day: 3, outcome: 'smb' };
    applyVisual(crowd, scene, ev, cx);
    expect(activeWalkers(crowd)).toBe(1);
    const w = crowd.walkers[0];
    expect(w.kind).toBe('smb');
    expect(w.coinAmount).toBe(300);
    near(w.path[0].y, scene.anchors.streetY);
    const prod = scene.first.product!;
    expect(w.path.some((p) => p.x === prod.aisle.x && p.y === prod.aisle.y)).toBe(true);
    const coin = w.path.find((p) => p.act === 'coin')!;
    near(coin.x, scene.anchors.receptionFront.x);
    near(w.path[w.path.length - 1].y, scene.anchors.streetY);
  });

  it('shows at most a few waiting prospects, then badges', () => {
    const { scene, crowd, cx } = world(true);
    for (let i = 0; i < MAX_WAITING + 2; i++) applyVisual(crowd, scene, { t: 'visitor', day: 3, outcome: 'waiting' }, cx);
    expect(countKind(crowd, 'waiting')).toBe(MAX_WAITING);
    expect(representedWalkers(crowd)).toBe(MAX_WAITING + 2);
  });

  it('lets an enterprise visitor replace a waiting prospect and carry a slip to the tray', () => {
    const { scene, crowd, cx } = world(true);
    applyVisual(crowd, scene, { t: 'visitor', day: 3, outcome: 'waiting' }, cx);
    expect(countKind(crowd, 'waiting')).toBe(1);
    applyVisual(crowd, scene, { t: 'visitor', day: 4, outcome: 'enterprise' }, cx);
    expect(countKind(crowd, 'waiting')).toBe(0);
    expect(countKind(crowd, 'enterprise')).toBe(1);
    const w = crowd.walkers.find((x) => x.active)!;
    const slip = w.path.find((p) => p.act === 'slip')!;
    near(slip.tx, scene.anchors.tray.x);
    near(slip.x, scene.first.sales!.aisle.x);
    applyVisual(crowd, scene, { t: 'visitor', day: 4, outcome: 'left' }, cx);
    expect(countKind(crowd, 'left')).toBe(1);
    expect(crowd.walkers.find((x) => x.active && x.kind === 'left')!.path.some((p) => p.act === 'puff')).toBe(true);
  });

  it('works without a lobby or departments: everything happens at the garage', () => {
    const { scene, crowd, cx } = world(false);
    applyVisual(crowd, scene, { t: 'visitor', day: 1, outcome: 'enterprise' }, cx);
    applyVisual(crowd, scene, { t: 'churn', day: 1, kind: 'smb' }, cx);
    applyVisual(crowd, scene, { t: 'feature', day: 1, features: 1 }, cx);
    applyVisual(crowd, scene, { t: 'outage', day: 1 }, cx);
    applyVisual(crowd, scene, { t: 'tier', day: 1, tier: 2 }, cx);
    applyVisual(crowd, scene, { t: 'close', day: 30, month: 0 }, cx);
    applyVisual(crowd, scene, { t: 'coins', day: 30, amount: 1200, source: 'smb' }, cx);
    applyVisual(crowd, scene, { t: 'invoice', day: 30, amount: 30000, dueDay: 120 }, cx);
    applyVisual(crowd, scene, { t: 'asset', day: 30, kind: 'server', op: 'buy' }, cx);
    applyVisual(crowd, scene, { t: 'room', day: 30, roomId: 'nope', op: 'close' }, cx);
    applyVisual(crowd, scene, { t: 'toast', day: 30, text: 'hi', tone: 'info' }, cx);
    expect(activeWalkers(crowd)).toBe(2);
    const types = crowd.effects.filter((e) => e.active).map((e) => e.type).sort();
    expect(types).toEqual(['coin', 'confetti', 'flash', 'glow', 'pop', 'pop', 'slip', 'sweep']);
    for (const w of crowd.walkers) {
      if (!w.active) continue;
      for (const p of w.path) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it('walks a hire to the seat and a leaver from it', () => {
    const { s, scene, crowd, cx } = world(false);
    const founder = s.people[0];
    applyVisual(crowd, scene, { t: 'hire', day: 2, personId: founder.id }, cx);
    const w = crowd.walkers.find((x) => x.active)!;
    expect(w.kind).toBe('hire');
    expect(w.personId).toBe(founder.id);
    const seat = scene.seats.get(founder.id)!;
    near(w.path[w.path.length - 1].x, seat.x);
    applyVisual(crowd, scene, { t: 'leave', day: 2, personId: founder.id, name: 'You', reason: 'quit' }, cx);
    const lv = crowd.walkers.find((x) => x.active && x.kind === 'leave')!;
    near(lv.path[0].x, seat.x);
    near(lv.path[lv.path.length - 1].y, scene.anchors.streetY);
    applyVisual(crowd, scene, { t: 'hire', day: 2, personId: 'ghost' }, cx);
    expect(activeWalkers(crowd)).toBe(2);
  });
});

describe('looks (DESIGN 3, 17: outfits, hair, skin from the palettes)', () => {
  it('hashes a stable look per person from the palettes', () => {
    const a = lookOf('p7', 'sales');
    const b = lookOf('p7', 'sales');
    expect(a).toEqual(b);
    expect(SKIN).toContain(a.skin);
    expect(HAIR).toContain(a.hair);
    expect(TROUSERS).toContain(a.trousers);
    expect(a.outfit).toBeGreaterThanOrEqual(0);
    expect(a.outfit).toBeLessThan(OUTFITS);
    expect(a.style).toBeGreaterThanOrEqual(0);
    expect(a.style).toBeLessThan(HAIR_STYLES);
    expect(a.carry).toBe(CARRY_NONE);
    expect(lookKey(a)).toBe(lookKey(b));
    expect(lookKey(lookOf('p8', 'sales'))).not.toBe(lookKey(lookOf('p8', 'product')));
  });

  it('spreads a crowd over every outfit and hairstyle', () => {
    const outfits = new Set<number>();
    const styles = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const l = lookOf('p' + i, 'product');
      outfits.add(l.outfit);
      styles.add(l.style);
    }
    expect(outfits.size).toBe(OUTFITS);
    expect(styles.size).toBe(HAIR_STYLES);
  });

  it('seats carry their look and sprite key', () => {
    const s = createGame(7);
    const sc = buildScene(s, computeLayout({ width: 420, height: 560, floors: 1 }));
    const seat = sc.first.garage!.seats[0];
    expect(seat.look).toEqual(lookOf(seat.personId, 'product'));
    expect(seat.key).toBe(lookKey(seat.look));
    expect(seat.look.skin).toBe(SKIN[seat.skin]);
    expect(seat.look.hair).toBe(HAIR[seat.hair]);
  });

  it('caches outfit shades per colour', () => {
    const a = shades('#5B8DEF');
    expect(shades('#5B8DEF')).toBe(a);
    expect(a.light).not.toBe(a.dark);
    expect(a.light).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('walk cycle and carried items', () => {
  it('steps through the four frames with the distance walked and stands on −1', () => {
    const crowd = createCrowd(2, 40);
    const w = spawnWalker(crowd, 'smb', [wp(0, 0), wp(1000, 0)], { body: '#000' })!;
    expect(walkFrame(w, 40)).toBe(-1);
    const seen: number[] = [];
    const perFrame = (WALK_CYCLE_CELLS * 40) / WALK_FRAMES;
    for (let i = 0; i < 40; i++) {
      stepCrowd(crowd, perFrame / w.speed);
      seen.push(walkFrame(w, 40));
    }
    expect(seen.slice(0, 8)).toEqual([1, 2, 3, 0, 1, 2, 3, 0]);
    for (const f of seen) expect(f >= 0 && f < WALK_FRAMES).toBe(true);
    expect(walkFrame(w, 0)).toBe(-1);
  });

  it('gives visitors a bag or a laptop, prospects a briefcase, hires a laptop and leavers a box', () => {
    const s = createGame(11);
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    const scene = buildScene(s, l);
    const crowd = createCrowd(CONFIG.ui.maxWalkers, l.cell);
    const cx: ChoreoContext = {
      smbPrice: 300,
      seatOf: (id) => scene.seats.get(id) ?? null,
      lastSeatOf: (id) => scene.seats.get(id) ?? null,
      lastRoomCentre: () => null,
      assetPoint: () => null,
    };
    const carries = new Set<number>();
    for (let i = 0; i < 12; i++) {
      applyVisual(crowd, scene, { t: 'visitor', day: i, outcome: 'smb' }, cx);
      const w = crowd.walkers.find((x) => x.active && x.kind === 'smb')!;
      carries.add(w.look.carry);
      w.active = false;
    }
    expect([...carries].sort()).toEqual([CARRY_BAG, CARRY_LAPTOP]);
    applyVisual(crowd, scene, { t: 'visitor', day: 1, outcome: 'waiting' }, cx);
    const waiting = crowd.walkers.find((x) => x.active && x.kind === 'waiting')!;
    expect(waiting.look.carry).toBe(CARRY_CASE);
    applyVisual(crowd, scene, { t: 'visitor', day: 2, outcome: 'enterprise' }, cx);
    expect(waiting.kind).toBe('enterprise');
    expect(waiting.look.carry).toBe(CARRY_CASE);
    waiting.active = false;
    const founder = s.people[0];
    applyVisual(crowd, scene, { t: 'hire', day: 2, personId: founder.id }, cx);
    const hire = crowd.walkers.find((x) => x.active && x.kind === 'hire')!;
    const seat = scene.seats.get(founder.id)!;
    expect(hire.look.carry).toBe(CARRY_LAPTOP);
    expect(hire.look.outfit).toBe(seat.look.outfit);
    expect(hire.look.style).toBe(seat.look.style);
    expect(hire.look.trousers).toBe(seat.look.trousers);
    expect(hire.look.skin).toBe(seat.look.skin);
    applyVisual(crowd, scene, { t: 'leave', day: 3, personId: founder.id, name: 'You', reason: 'fired' }, cx);
    const leaver = crowd.walkers.find((x) => x.active && x.kind === 'leave')!;
    expect(leaver.look.carry).toBe(CARRY_BOX);
    expect(leaver.look.hair).toBe(seat.look.hair);
  });

  it('keeps the look indices in range for every spawn', () => {
    const crowd = createCrowd(4, 40);
    for (let i = 0; i < 50; i++) {
      const w = spawnWalker(crowd, 'smb', [wp(0, 0), wp(10, 0)], { body: '#123456', trousers: i % 2 === 0 ? -1 : 99 })!;
      expect(w.look.body).toBe('#123456');
      expect(TROUSERS).toContain(w.look.trousers);
      expect(w.look.outfit).toBeLessThan(OUTFITS);
      expect(w.look.style).toBeLessThan(HAIR_STYLES);
      w.active = false;
    }
  });
});

describe('build plots (DESIGN 17: dashed "Build here" plots on free slots)', () => {
  const lotRooms = (s: GameState): void => {
    const lb = CONFIG.grid.lobby;
    s.rooms.push({ id: 'lobby', kind: 'lobby', size: 'small', floor: 0, x: lb.x, y: lb.y, w: lb.w, h: lb.h, rent: 0, openedDay: 0 });
  };

  it('tiles the free area with non-overlapping plots a RULES.roomSize room fits, lowest row first', () => {
    const s = createGame(3);
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    const plots = buildPlots(s, l);
    const fp = footprint('product', RULES.roomSize);
    expect(plots.length).toBeGreaterThan(0);
    const spots = validSpots(s, 'product', RULES.roomSize, 0);
    for (const p of plots) {
      expect(p.floor).toBe(0);
      expect(p.w).toBe(fp.w);
      expect(p.h).toBe(fp.h);
      expect(spots.some((sp) => sp.x === p.x && sp.y === p.y)).toBe(true);
      near(p.rect.x, l.x0 + p.x * l.cell);
      near(p.rect.y, l.floorTop[0] + p.y * l.cell);
    }
    for (let i = 0; i < plots.length; i++) {
      for (let j = i + 1; j < plots.length; j++) {
        const a = plots[i];
        const b = plots[j];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
    // the next room's plot is the sim's autoSpot: the lowest row, then leftmost
    const next = plots.filter((p) => p.next);
    expect(next.length).toBe(1);
    const sorted = spots.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    expect(next[0].x).toBe(sorted[0].x);
    expect(next[0].y).toBe(sorted[0].y);
    // the garage, the lobby cells and every plot never overlap
    const g = CONFIG.grid.garage;
    const lb = CONFIG.grid.lobby;
    for (const p of plots) {
      const hits = (r: { x: number; y: number; w: number; h: number }): boolean => p.x < r.x + r.w && r.x < p.x + p.w && p.y < r.y + r.h && r.y < p.y + p.h;
      expect(hits(g)).toBe(false);
      expect(hits(lb)).toBe(false);
    }
  });

  it('loses the plots a new room covers and adds a floor of plots with the second floor', () => {
    const s = createGame(3);
    lotRooms(s);
    const l1 = computeLayout({ width: 420, height: 560, floors: 1 });
    const before = buildPlots(s, l1);
    const first = before[0];
    s.rooms.push({ id: 'r1', kind: 'product', size: RULES.roomSize, floor: 0, x: first.x, y: first.y, w: first.w, h: first.h, rent: 4500, openedDay: 0 });
    const after = buildPlots(s, l1);
    expect(after.length).toBe(before.length - 1);
    expect(after.some((p) => p.x === first.x && p.y === first.y)).toBe(false);
    expect(after[0].next).toBe(true);
    // a floor the state does not have yet shows no plots, even when the layout has room for it
    expect(buildPlots(s, computeLayout({ width: 420, height: 560, floors: 2 })).every((p) => p.floor === 0)).toBe(true);
    s.floors = 2;
    const two = buildPlots(s, computeLayout({ width: 420, height: 560, floors: 2 }));
    expect(two.some((p) => p.floor === 1)).toBe(true);
    expect(two.filter((p) => p.next).length).toBe(1);
    expect(two[0].floor).toBe(0);
    const sc = buildScene(s, computeLayout({ width: 420, height: 560, floors: 2 }));
    expect(sc.plots).toEqual(two);
    expect(sc.companyName).toBe(s.companyName);
  });

  it('shows no plots when nothing fits', () => {
    const s = createGame(3);
    const l = computeLayout({ width: 420, height: 560, floors: 1 });
    for (const sp of validSpots(s, 'product', RULES.roomSize, 0)) {
      const fp = footprint('product', RULES.roomSize);
      if (buildPlots(s, l).some((p) => p.x === sp.x && p.y === sp.y)) {
        s.rooms.push({ id: 'r' + sp.x + sp.y, kind: 'product', size: RULES.roomSize, floor: 0, x: sp.x, y: sp.y, w: fp.w, h: fp.h, rent: 4500, openedDay: 0 });
      }
    }
    expect(buildPlots(s, l)).toEqual([]);
  });
});

describe('street life and sprites', () => {
  it('runs a bus across the road every BUS_PERIOD seconds, alternating direction', () => {
    expect(busProgress(0)).toBe(0);
    expect(busProgress(BUS_CROSS / 2)).toBeCloseTo(0.5);
    expect(busProgress(BUS_CROSS + 1)).toBe(-1);
    expect(busProgress(BUS_PERIOD - 0.1)).toBe(-1);
    expect(busProgress(BUS_PERIOD + 1)).toBeCloseTo(1 / BUS_CROSS);
    expect(busProgress(-5)).toBe(-1);
    expect(busProgress(NaN)).toBe(-1);
    expect(busDir(1)).toBe(1);
    expect(busDir(BUS_PERIOD + 1)).toBe(-1);
    expect(busDir(2 * BUS_PERIOD + 1)).toBe(1);
    near(busX(0, 1, 420, 50), -50);
    near(busX(1, 1, 420, 50), 470);
    near(busX(0, -1, 420, 50), 470);
    near(busX(0.5, -1, 420, 50), 210);
  });

  it('has no sprites without a DOM and never throws', () => {
    const cache = createSpriteCache();
    expect(cache.enabled).toBe(false);
    resetSpriteCache(cache, 40, 2);
    expect(cache.cell).toBe(40);
    let painted = 0;
    const s = getSprite(cache, 'k', 10, 10, 5, 5, () => { painted++; }, null);
    expect(s).toBeNull();
    expect(painted).toBe(0);
  });
});

// ---------------------------------------------------------------- the whole renderer on a fake canvas

interface Call {
  name: string;
  args: unknown[];
}

/** A CanvasRenderingContext2D stand-in that records every method call and accepts every property. */
function fakeCtx(calls: Call[]): CanvasRenderingContext2D {
  const props: Record<string, unknown> = { globalAlpha: 1 };
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== 'string') return undefined;
      if (key in props) return props[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 });
      if (key === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
      return (...args: unknown[]) => { calls.push({ name: key, args }); };
    },
    set(_t, key, v) {
      if (typeof key === 'string') props[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

interface FakeCanvas {
  canvas: HTMLCanvasElement;
  listeners: Map<string, ((e: unknown) => void)[]>;
  /** the on-screen size relative to the CSS size (the shell scales the column with a transform) */
  scale: number;
  fire(type: string, e: { pointerId: number; button?: number; clientX: number; clientY: number }): void;
}

function fakeCanvas(w: number, h: number, ctx: CanvasRenderingContext2D): FakeCanvas {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const fc: FakeCanvas = {
    canvas: null as unknown as HTMLCanvasElement,
    listeners,
    scale: 1,
    fire(type, e) {
      for (const f of listeners.get(type) ?? []) f({ button: 0, ...e });
    },
  };
  const el = {
    width: 0,
    height: 0,
    clientWidth: w,
    clientHeight: h,
    getContext: () => ctx,
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w * fc.scale, height: h * fc.scale }),
    setPointerCapture: () => undefined,
  };
  fc.canvas = el as unknown as HTMLCanvasElement;
  return fc;
}

interface FakeController extends GameController {
  state: GameState;
  selectedRoomId: string | null;
  placement: PlacementMode | null;
  actions: Action[];
  selected: (string | null)[];
  toasts: string[];
  placementSets: (PlacementMode | null)[];
}

function fakeController(state: GameState): FakeController {
  const listeners: ((s: GameState) => void)[] = [];
  const c: FakeController = {
    state,
    speed: 1,
    dayProgress: 0,
    selectedRoomId: null,
    placement: null,
    actions: [],
    selected: [],
    toasts: [],
    placementSets: [],
    tick: () => false,
    dispatch(a) { c.actions.push(a); return OK; },
    can: () => OK,
    subscribe(fn) { listeners.push(fn); return () => { listeners.splice(listeners.indexOf(fn), 1); }; },
    newGame: () => undefined,
    drainVisuals() { const v = state.visuals; state.visuals = []; return v; },
    setPlacement(m) { c.placement = m; c.placementSets.push(m); },
    selectRoom(id) { c.selected.push(id); c.selectedRoomId = id; },
    toast(text) { c.toasts.push(text); },
  };
  return c;
}

describe('renderer on a fake canvas', () => {
  const g = globalThis as { window?: unknown };
  beforeAll(() => { g.window = { devicePixelRatio: 2 }; });
  afterAll(() => { delete g.window; });

  it('sizes for the device pixel ratio and draws the garage', () => {
    const calls: Call[] = [];
    const fc = fakeCanvas(420, 560, fakeCtx(calls));
    const ctrl = fakeController(createGame(5));
    const r = createOfficeRenderer(fc.canvas, ctrl);
    r.resize();
    expect(fc.canvas.width).toBe(840);
    expect(fc.canvas.height).toBe(1120);
    r.frame(16);
    expect(calls.some((k) => k.name === 'setTransform' && k.args[0] === 2 && k.args[3] === 2)).toBe(true);
    expect(calls.some((k) => k.name === 'fillText' && k.args[0] === 'Garage')).toBe(true);
    expect(calls.filter((k) => k.name === 'fillRect').length).toBeGreaterThan(5);
    r.destroy();
  });

  it('animates visuals, shows the owed sign and survives a second floor', () => {
    const calls: Call[] = [];
    const fc = fakeCanvas(420, 560, fakeCtx(calls));
    const state = createGame(5);
    const ctrl = fakeController(state);
    const r = createOfficeRenderer(fc.canvas, ctrl);
    r.resize();
    state.visuals.push(
      { t: 'visitor', day: 1, outcome: 'smb' },
      { t: 'visitor', day: 1, outcome: 'waiting' },
      { t: 'coins', day: 1, amount: 300, source: 'smb' },
      { t: 'feature', day: 1, features: 1 },
      { t: 'hire', day: 1, personId: state.people[0].id },
    );
    for (let i = 0; i < 90; i++) r.frame(16);
    // coin popups are green pills with white text (DESIGN 17), so the amount is filled, not stroked
    expect(calls.some((k) => k.name === 'fillText' && String(k.args[0]).startsWith('+$'))).toBe(true);
    // the "Owed to you" sign needs a lobby and open receivables
    const lb = CONFIG.grid.lobby;
    state.rooms.push({ id: 'lobby', kind: 'lobby', size: 'small', floor: 0, x: lb.x, y: lb.y, w: lb.w, h: lb.h, rent: 0, openedDay: 0 });
    state.invoices.push({ id: 'inv1', customerId: 'c1', amount: 184_000, issuedDay: 1, dueDay: 90, status: 'open', settledDay: null, late: false });
    calls.length = 0;
    r.frame(16);
    expect(calls.some((k) => k.name === 'fillText' && k.args[0] === 'Owed to you $184k')).toBe(true);
    // the lobby carries the company's plaque instead of a room label (DESIGN 17)
    expect(calls.some((k) => k.name === 'fillText' && k.args[0] === state.companyName)).toBe(true);
    expect(calls.some((k) => k.name === 'fillText' && k.args[0] === 'Lobby')).toBe(false);
    // buying the second floor changes the layout under a live crowd
    state.floors = 2;
    state.visuals.push({ t: 'asset', day: 2, kind: 'secondFloor', op: 'buy' }, { t: 'close', day: 30, month: 0 }, { t: 'outage', day: 30 });
    for (let i = 0; i < 30; i++) r.frame(16);
    // a new game resets everything
    ctrl.state = createGame(6);
    r.frame(16);
    r.destroy();
    r.frame(16);
  });

  it('turns taps into room selection and placement, through a scaled column', () => {
    const calls: Call[] = [];
    const fc = fakeCanvas(420, 560, fakeCtx(calls));
    const state = createGame(5);
    const ctrl = fakeController(state);
    const r = createOfficeRenderer(fc.canvas, ctrl);
    r.resize();
    r.frame(16);
    const l = computeLayout({ width: 420, height: 560, floors: 1, pad: LOT_PAD });
    fc.scale = 0.5;
    const tapAt = (id: number, x: number, y: number): void => {
      fc.fire('pointerdown', { pointerId: id, clientX: x * fc.scale, clientY: y * fc.scale });
      r.frame(16);
      fc.fire('pointerup', { pointerId: id, clientX: x * fc.scale, clientY: y * fc.scale });
    };
    const gx = l.x0 + 1 * l.cell;
    const gy = l.floorTop[0] + 7 * l.cell;
    tapAt(1, gx, gy);
    expect(ctrl.selected).toEqual(['garage']);
    tapAt(2, l.x0 + 5.5 * l.cell, l.floorTop[0] + 0.5 * l.cell);
    expect(ctrl.selected).toEqual(['garage', null]);
    tapAt(3, l.x0 + 2 * l.cell, l.streetTop + 0.5 * l.cell);
    expect(ctrl.selected).toEqual(['garage', null, null]);
    // a drag is not a tap
    fc.fire('pointerdown', { pointerId: 4, clientX: gx * fc.scale, clientY: gy * fc.scale });
    fc.fire('pointermove', { pointerId: 4, clientX: (gx + 40) * fc.scale, clientY: gy * fc.scale });
    fc.fire('pointerup', { pointerId: 4, clientX: (gx + 40) * fc.scale, clientY: gy * fc.scale });
    expect(ctrl.selected.length).toBe(3);
    // a right button press is ignored
    fc.fire('pointerdown', { pointerId: 5, button: 2, clientX: gx * fc.scale, clientY: gy * fc.scale });
    fc.fire('pointerup', { pointerId: 5, button: 2, clientX: gx * fc.scale, clientY: gy * fc.scale });
    expect(ctrl.selected.length).toBe(3);
    // placement mode: a tap off the spots does nothing, a tap on a spot places and ends the mode
    ctrl.placement = { kind: 'sales', size: 'small', floor: 0, spots: [{ x: 4, y: 0 }, { x: 0, y: 0 }] };
    tapAt(6, gx, gy);
    expect(ctrl.actions).toEqual([]);
    expect(ctrl.placement).not.toBeNull();
    expect(ctrl.selected.length).toBe(3);
    tapAt(7, l.x0 + 4.5 * l.cell, l.floorTop[0] + 0.5 * l.cell);
    expect(ctrl.actions).toEqual([{ type: 'placeRoom', kind: 'sales', size: 'small', floor: 0, x: 4, y: 0 }]);
    expect(ctrl.placementSets).toEqual([null]);
    expect(ctrl.placement).toBeNull();
    // a refused placement is toasted by the shell's dispatch (controller.ts), so the renderer must not toast it again
    ctrl.dispatch = () => ({ ok: false, reason: 'No cash.' });
    ctrl.placement = { kind: 'demo', size: 'small', floor: 0, spots: [{ x: 0, y: 0 }] };
    tapAt(8, l.x0 + 0.5 * l.cell, l.floorTop[0] + 0.5 * l.cell);
    expect(ctrl.toasts).toEqual([]);
    expect(ctrl.placement).toBeNull();
    r.destroy();
    expect(fc.listeners.get('pointerdown')?.length ?? 0).toBe(0);
    expect(fc.listeners.get('pointerup')?.length ?? 0).toBe(0);
    expect(fc.listeners.get('pointermove')?.length ?? 0).toBe(0);
    expect(fc.listeners.get('pointercancel')?.length ?? 0).toBe(0);
  });
});
