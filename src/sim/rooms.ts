/**
 * The building: grid placement, opening and closing rooms, the lobby, the demo room.
 * DESIGN.md section 5.
 */
import { CONFIG } from './config';
import * as L from './ledger';
import * as S from './selectors';
import { fire, founderOf, seatPerson } from './staff';
import { fmtMoney, roomName } from './names';
import { no, OK } from './types';
import type { Asset, GameState, Role, Room, RoomSize, Verdict } from './types';

export function roomFootprint(kind: Role | 'demo', size: RoomSize): { w: number; h: number } {
  if (kind === 'demo') return { w: CONFIG.rooms.demo.w, h: CONFIG.rooms.demo.h };
  const s = CONFIG.rooms.size[size];
  return { w: s.w, h: s.h };
}

export function roomRent(kind: Role | 'demo', size: RoomSize): number {
  return kind === 'demo' ? CONFIG.rooms.demo.rent : CONFIG.rooms.size[size].rent;
}

function overlaps(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/** In bounds, no overlap with rooms/garage/lobby on that floor, floor exists, cash for the demo room, one demo room max, Finance unlocked. */
export function canPlaceRoom(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1, x: number, y: number): Verdict {
  // DESIGN.md 8: Finance unlocks the day the first enterprise invoice is issued
  if (kind === 'finance' && !state.financeUnlocked) return no('Finance unlocks with your first enterprise invoice.');
  if (kind === 'demo') {
    if (S.hasRoom(state, 'demo') || S.hasDemoRoom(state)) return no('You already have a demo room.');
    const price = CONFIG.assets.catalogue.demoRoom.price;
    if (state.cash < price) return no(`Not enough cash (${fmtMoney(price)}).`);
  }
  if (floor >= state.floors) return no('Buy the second floor first.');
  if (!Number.isInteger(x) || !Number.isInteger(y)) return no('Pick a grid cell.');
  const { w, h } = roomFootprint(kind, size);
  const g = CONFIG.grid;
  if (x < 0 || y < 0 || x + w > g.w || y + h > g.h) return no('Out of bounds.');
  // DESIGN.md 5: the lobby cells on floor 0 stay free even before the lobby appears
  if (floor === 0 && overlaps(x, y, w, h, g.lobby.x, g.lobby.y, g.lobby.w, g.lobby.h)) return no('That spot is reserved for the lobby.');
  for (const r of state.rooms) {
    if (r.floor === floor && overlaps(x, y, w, h, r.x, r.y, r.w, r.h)) return no(`Overlaps the ${roomName(r.kind)}.`);
  }
  return OK;
}

/** All top-left cells where this room would fit on the floor (for the UI to highlight). */
export function validSpots(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1): { x: number; y: number }[] {
  const { w, h } = roomFootprint(kind, size);
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y + h <= CONFIG.grid.h; y++) {
    for (let x = 0; x + w <= CONFIG.grid.w; x++) {
      if (canPlaceRoom(state, kind, size, floor, x, y).ok) out.push({ x, y });
    }
  }
  return out;
}

function floorWord(floor: 0 | 1): string {
  return floor === 0 ? 'downstairs' : 'upstairs';
}

/**
 * Creates the room (rent starts at once). First department room also creates the rent-free lobby.
 * kind 'demo' records capex and creates the demoRoom asset linked to the room. Visual 'room' open.
 */
export function placeRoom(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1, x: number, y: number): Room {
  const { w, h } = roomFootprint(kind, size);
  const room: Room = {
    id: `r${state.nextId++}`,
    kind,
    size: kind === 'demo' ? 'small' : size,
    floor,
    x,
    y,
    w,
    h,
    rent: roomRent(kind, size),
    openedDay: state.day,
  };
  state.rooms.push(room);
  state.visuals.push({ t: 'room', day: state.day, roomId: room.id, op: 'open' });

  if (kind === 'demo') {
    // DESIGN.md 5/7: capex only, no rent; the asset depreciates like any other
    const cat = CONFIG.assets.catalogue.demoRoom;
    L.recordCapex(state, cat.price);
    state.assets.push({
      id: `a${state.nextId++}`, kind: 'demoRoom', cost: cat.price, bookValue: cat.price, lifeMonths: cat.lifeMonths,
      boughtDay: state.day, roomId: room.id,
    });
    state.log.push({ day: state.day, text: `Built a demo room ${floorWord(floor)} for ${fmtMoney(cat.price)}. Enterprise deals ×${CONFIG.assets.demoRoomMult}.`, tone: 'info' });
    return room;
  }

  state.log.push({ day: state.day, text: `Opened a ${size} ${roomName(kind)} ${floorWord(floor)}. Rent ${fmtMoney(room.rent)}/mo starts today.`, tone: 'info' });
  // DESIGN.md 5: the lobby appears rent-free when the first room is placed
  if (!S.hasRoom(state, 'lobby')) {
    const lb = CONFIG.grid.lobby;
    const lobby: Room = {
      id: 'lobby', kind: 'lobby', size: 'small', floor: 0, x: lb.x, y: lb.y, w: lb.w, h: lb.h,
      rent: CONFIG.rooms.lobby.rent, openedDay: state.day,
    };
    state.rooms.push(lobby);
    state.visuals.push({ t: 'room', day: state.day, roomId: lobby.id, op: 'open' });
    state.log.push({ day: state.day, text: 'The lobby is open: visitors now come in through the front door.', tone: 'info' });
  }
  return room;
}

export function canCloseRoom(state: GameState, roomId: string): Verdict {
  const room = S.roomById(state, roomId);
  if (!room) return no('No such room.');
  if (room.kind === 'garage') return no('The garage stays.');
  if (room.kind === 'lobby') return no('The lobby stays.');
  return OK;
}

function disposeAsset(state: GameState, a: Asset): number {
  const proceeds = L.recordDisposal(state, a);
  const i = state.assets.indexOf(a);
  if (i >= 0) state.assets.splice(i, 1);
  return proceeds;
}

/**
 * Fires occupants with severance ('roomClosed'), sells desks in it at 60% of book (ledger.recordDisposal),
 * removes the room. Closing the demo room disposes the demoRoom asset. Garage and lobby cannot close.
 * Closing the last Marketing room resets adBudget to 0.
 */
export function closeRoom(state: GameState, roomId: string): void {
  const room = S.roomById(state, roomId);
  if (!room || room.kind === 'garage' || room.kind === 'lobby') return;

  // DESIGN.md 5: closing a room fires its staff (severance) and sells its desks at 60% of book
  let severance = 0;
  let letGo = 0;
  for (const p of S.occupantsOf(state, room.id)) {
    if (p.founder) continue;
    severance += S.severanceOf(state, p);
    fire(state, p.id, 'roomClosed');
    letGo += 1;
  }
  let proceeds = 0;
  for (const desk of S.desksIn(state, room.id)) proceeds += disposeAsset(state, desk);
  if (room.kind === 'demo') {
    for (const a of state.assets.filter((x) => x.kind === 'demoRoom' && x.roomId === room.id)) proceeds += disposeAsset(state, a);
  }

  state.rooms.splice(state.rooms.indexOf(room), 1);
  if (room.kind === 'marketing' && !S.hasRoom(state, 'marketing')) state.adBudget = 0;

  const founder = founderOf(state);
  if (founder && founder.roomId === room.id) {
    founder.roomId = null;
    if (!seatPerson(state, founder)) {
      state.log.push({ day: state.day, text: 'You have no desk. Add one and you will sit down again.', tone: 'bad' });
    }
  }

  state.visuals.push({ t: 'room', day: state.day, roomId: room.id, op: 'close' });
  const parts = [`Closed the ${roomName(room.kind)}.`];
  if (letGo > 0) parts.push(`${letGo} ${letGo === 1 ? 'person' : 'people'} let go, severance ${fmtMoney(severance)}.`);
  if (proceeds > 0) parts.push(`Furniture sold for ${fmtMoney(proceeds)}.`);
  state.log.push({ day: state.day, text: parts.join(' '), tone: 'info' });
}
