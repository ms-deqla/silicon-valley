/**
 * Visual events → crowd choreography: which figure walks where, which effect
 * plays. Pure (no DOM); allocations happen only when something spawns.
 * DESIGN.md section 13 and the renderer brief:
 *   visitor smb: street → door → lobby → product room → reception (+$ price) → out
 *   visitor enterprise: … → sales room, lingers, invoice slip flies to the tray, out
 *   visitor left: door → lobby → grey puff → out
 *   visitor waiting: stands in the lobby until an enterprise visitor or a leaver replaces it
 */
import type { AssetKind, VisualEvent } from '../../sim/types';
import type { Anchors, RoomView, Scene, SeatInfo } from './scene';
import type { Crowd, Waypoint } from './walkers';
import { badgeWalker, coinAt, countKind, findWalker, retargetWalker, spawnEffect, spawnWalker, wp } from './walkers';
import { DEPT, GOLD, ROOM_BASE, SMB_SHIRTS, WALKER_BODY } from './palette';
import { hash01 } from './util';
import type { Pt } from './util';

/** waiting prospects shown in the lobby before they stack into a badge */
export const MAX_WAITING = 3;
const SELL_COLOR = '#9AA0AA';
const CLOSED_ROOM_COLOR = '#8E94A3';

export interface ChoreoContext {
  /** today's SMB monthly price, shown as "+$X" when a visitor converts */
  smbPrice: number;
  /** current seat of a person on the floor (used by 'hire') */
  seatOf(personId: string): SeatInfo | null;
  /** last known seat of a person who may already be gone (used by 'leave') */
  lastSeatOf(personId: string): SeatInfo | null;
  /** last known centre of a room that may already be closed */
  lastRoomCentre(roomId: string): Pt | null;
  /** where an asset of this kind lives (the room of the newest one), or null */
  assetPoint(kind: AssetKind): Pt | null;
}

function streetSides(crowd: Crowd, a: Anchors): { from: number; to: number } {
  const left = hash01('side', crowd.spawned) < 0.5;
  return left ? { from: a.leftX, to: a.rightX } : { from: a.rightX, to: a.leftX };
}

function enter(out: Waypoint[], a: Anchors, fromX: number): void {
  out.push(wp(fromX, a.streetY));
  out.push(wp(a.doorOut.x, a.doorOut.y));
  out.push(wp(a.entry.x, a.entry.y));
  out.push(wp(a.lobbyPoint.x, a.lobbyPoint.y));
}

function leave(out: Waypoint[], a: Anchors, toX: number): void {
  out.push(wp(a.entry.x, a.entry.y));
  out.push(wp(a.doorOut.x, a.doorOut.y));
  out.push(wp(toX, a.streetY));
}

/** Add the staircase legs when the floors differ (DESIGN 5: floor 1 above floor 0). */
function via(out: Waypoint[], a: Anchors, from: 0 | 1, to: 0 | 1): void {
  if (from === to || !a.stairBottom || !a.stairTop) return;
  if (to === 1) {
    out.push(wp(a.stairBottom.x, a.stairBottom.y));
    out.push(wp(a.stairTop.x, a.stairTop.y));
  } else {
    out.push(wp(a.stairTop.x, a.stairTop.y));
    out.push(wp(a.stairBottom.x, a.stairBottom.y));
  }
}

function visitRoom(out: Waypoint[], a: Anchors, view: RoomView, wait: number, act: Waypoint['act'], tx = 0, ty = 0): void {
  via(out, a, 0, view.room.floor);
  out.push(wp(view.aisle.x, view.aisle.y, wait, act, tx, ty));
  via(out, a, view.room.floor, 0);
  out.push(wp(a.lobbyPoint.x, a.lobbyPoint.y));
}

export function applyVisual(crowd: Crowd, scene: Scene, ev: VisualEvent, cx: ChoreoContext): void {
  const a = scene.anchors;
  const c = scene.cell;
  switch (ev.t) {
    case 'visitor': {
      const sides = streetSides(crowd, a);
      if (ev.outcome === 'smb') {
        const path: Waypoint[] = [];
        enter(path, a, sides.from);
        const prod = scene.first.product;
        if (prod) visitRoom(path, a, prod, 0.9, 'none');
        path.push(wp(a.receptionFront.x, a.receptionFront.y, 0.45, 'coin'));
        leave(path, a, sides.to);
        const shirt = SMB_SHIRTS[Math.floor(hash01('shirt', crowd.spawned) * SMB_SHIRTS.length)];
        spawnWalker(crowd, 'smb', path, { body: shirt, coinAmount: cx.smbPrice });
      } else if (ev.outcome === 'enterprise') {
        const waiting = findWalker(crowd, 'waiting');
        const path: Waypoint[] = [];
        if (waiting) path.push(wp(a.lobbyPoint.x, a.lobbyPoint.y));
        else enter(path, a, sides.from);
        const sales = scene.first.sales;
        if (sales) visitRoom(path, a, sales, 2.0, 'slip', a.tray.x, a.tray.y);
        else path.push(wp(a.lobbyPoint.x, a.lobbyPoint.y, 2.0, 'slip', a.tray.x, a.tray.y));
        leave(path, a, sides.to);
        if (waiting) retargetWalker(waiting, 'enterprise', path, { body: WALKER_BODY.enterprise, alpha: 1 });
        else spawnWalker(crowd, 'enterprise', path, { body: WALKER_BODY.enterprise });
      } else if (ev.outcome === 'left') {
        const waiting = findWalker(crowd, 'waiting');
        const path: Waypoint[] = [];
        if (!waiting) enter(path, a, sides.from);
        path.push(wp(a.lobbyPoint.x, a.lobbyPoint.y, 0.5, 'puff'));
        leave(path, a, sides.to);
        if (waiting) retargetWalker(waiting, 'left', path, { body: WALKER_BODY.left, alpha: 1 });
        else spawnWalker(crowd, 'left', path, { body: WALKER_BODY.left });
      } else {
        const n = countKind(crowd, 'waiting');
        if (n >= MAX_WAITING) { badgeWalker(crowd, 'waiting'); break; }
        const spot = a.waiting[n % a.waiting.length];
        const path: Waypoint[] = [];
        enter(path, a, sides.from);
        path.push(wp(spot.x, spot.y, Infinity));
        spawnWalker(crowd, 'waiting', path, { body: WALKER_BODY.waiting });
      }
      break;
    }
    case 'coins': {
      const sales = scene.first.sales;
      const pt = ev.source === 'deal' && sales ? { x: sales.aisle.x, y: sales.aisle.y - 0.6 * c } : a.coinOrigin;
      coinAt(crowd, pt.x, pt.y, ev.amount, ev.day, ev.source);
      break;
    }
    case 'invoice': {
      const sales = scene.first.sales;
      const from = sales ? { x: sales.aisle.x, y: sales.aisle.y - 0.5 * c } : { x: a.lobbyPoint.x, y: a.lobbyPoint.y - 0.5 * c };
      spawnEffect(crowd, 'slip', from.x, from.y, { x2: a.tray.x, y2: a.tray.y, seed: ev.day });
      break;
    }
    case 'churn': {
      const sides = streetSides(crowd, a);
      const sup = scene.first.support;
      const start = sup ? sup.aisle : a.lobbyPoint;
      const floor: 0 | 1 = sup ? sup.room.floor : 0;
      const path: Waypoint[] = [wp(start.x, start.y, 0.6, 'puff')];
      via(path, a, floor, 0);
      if (sup) path.push(wp(a.lobbyPoint.x, a.lobbyPoint.y));
      leave(path, a, sides.to);
      spawnWalker(crowd, 'churn', path, { body: ev.kind === 'enterprise' ? WALKER_BODY.enterprise : WALKER_BODY.churn, alpha: 0.85 });
      break;
    }
    case 'feature': {
      const v = scene.first.product ?? scene.first.garage;
      const pt = v ? v.centre : a.lobbyPoint;
      spawnEffect(crowd, 'confetti', pt.x, pt.y - 0.2 * c, { seed: ev.day * 31 + ev.features });
      break;
    }
    case 'tier': {
      const v = scene.first.rnd;
      const r = v ? v.rect : scene.floor0;
      spawnEffect(crowd, 'glow', r.x, r.y, { w: r.w, h: r.h, color: DEPT.rnd, seed: ev.tier });
      break;
    }
    case 'outage': {
      const v = scene.first.product;
      const r = v ? v.rect : scene.floor0;
      spawnEffect(crowd, 'flash', r.x, r.y, { w: r.w, h: r.h, seed: ev.day });
      break;
    }
    case 'close': {
      const r = scene.lotAll;
      spawnEffect(crowd, 'sweep', r.x, r.y, { w: r.w, h: r.h, seed: ev.month });
      break;
    }
    case 'hire': {
      const seat = cx.seatOf(ev.personId);
      if (!seat) break;
      const sides = streetSides(crowd, a);
      const path: Waypoint[] = [];
      enter(path, a, sides.from);
      via(path, a, 0, seat.floor);
      path.push(wp(seat.x, seat.y + 0.25 * c));
      spawnWalker(crowd, 'hire', path, { body: DEPT[seat.role], personId: ev.personId, skin: seat.skin, hair: seat.hair });
      break;
    }
    case 'leave': {
      const seat = cx.lastSeatOf(ev.personId);
      const sides = streetSides(crowd, a);
      const start: Pt = seat ? { x: seat.x, y: seat.y + 0.25 * c } : a.lobbyPoint;
      const floor: 0 | 1 = seat ? seat.floor : 0;
      const path: Waypoint[] = [wp(start.x, start.y, 0.3)];
      via(path, a, floor, 0);
      path.push(wp(a.lobbyPoint.x, a.lobbyPoint.y));
      leave(path, a, sides.to);
      spawnWalker(crowd, 'leave', path, {
        body: seat ? DEPT[seat.role] : WALKER_BODY.left,
        personId: ev.personId,
        skin: seat ? seat.skin : undefined,
        hair: seat ? seat.hair : undefined,
      });
      break;
    }
    case 'room': {
      if (ev.op === 'open') {
        const v = scene.byId.get(ev.roomId);
        if (v) spawnEffect(crowd, 'pop', v.centre.x, v.centre.y, { color: ROOM_BASE[v.room.kind], seed: ev.day });
      } else {
        const pt = cx.lastRoomCentre(ev.roomId) ?? a.lobbyPoint;
        spawnEffect(crowd, 'pop', pt.x, pt.y, { color: CLOSED_ROOM_COLOR, seed: ev.day });
      }
      break;
    }
    case 'asset': {
      const pt = assetPoint(scene, ev.kind, cx);
      spawnEffect(crowd, 'pop', pt.x, pt.y, { color: ev.op === 'buy' ? GOLD : SELL_COLOR, seed: ev.day });
      break;
    }
    case 'toast':
      break;
  }
}

function assetPoint(scene: Scene, kind: AssetKind, cx: ChoreoContext): Pt {
  const a = scene.anchors;
  switch (kind) {
    case 'server': {
      const v = scene.first.product ?? scene.first.garage;
      return v ? { x: v.rect.x + 0.35 * scene.cell, y: v.rect.y + 0.6 * scene.cell } : a.lobbyPoint;
    }
    case 'coffee':
      return scene.lobby ? scene.lobby.coffee : scene.first.garage ? scene.first.garage.centre : a.lobbyPoint;
    case 'demoRoom': {
      const v = scene.first.demo;
      return v ? v.centre : a.lobbyPoint;
    }
    case 'secondFloor': {
      const f = scene.floor1;
      return f ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : a.lobbyPoint;
    }
    case 'desk':
    case 'laptop':
      return cx.assetPoint(kind) ?? a.lobbyPoint;
  }
}
