/**
 * The building: grid placement, opening and closing rooms, the lobby, the demo room.
 * DESIGN.md section 5, and section 0 "Space (v2)" for the office that builds itself
 * around the tournament's hires (large rooms, the second floor built by the hire that
 * finds the ground floor full).
 */
import { CONFIG, RULES } from './config';
import * as assets from './assets';
import * as L from './ledger';
import * as S from './selectors';
import { fire, founderOf, seatPerson } from './staff';
import { fmtMoney, roomName } from './names';
import { no, OK } from './types';
import type { GameState, Role, Room, RoomSize, Verdict } from './types';

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

/** Geometry only: in bounds, clear of the lobby's cells on floor 0, no overlap with the rooms on that floor. */
function fitsOn(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1, x: number, y: number): Verdict {
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

/** In bounds, no overlap with rooms/garage/lobby on that floor, floor exists, cash for the demo room, one demo room max, Finance unlocked. */
export function canPlaceRoom(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1, x: number, y: number): Verdict {
  if ((kind === 'finance' && !RULES.finance) || (kind === 'rnd' && !RULES.rnd)) return no('Not in this game.');
  // DESIGN.md 8: Finance unlocks the day the first enterprise invoice is issued
  if (kind === 'finance' && !state.financeUnlocked) return no('Finance unlocks with your first enterprise invoice.');
  if (kind === 'demo') {
    if (S.hasRoom(state, 'demo') || S.hasDemoRoom(state)) return no('You already have a demo room.');
    const price = CONFIG.assets.catalogue.demoRoom.price;
    if (state.cash < price) return no(`Not enough cash (${fmtMoney(price)}).`);
  }
  if (floor >= state.floors) return no('Buy the second floor first.');
  if (!Number.isInteger(x) || !Number.isInteger(y)) return no('Pick a grid cell.');
  return fitsOn(state, kind, size, floor, x, y);
}

/** Every top-left cell of the floor where the footprint passes the given check. */
function scanSpots(kind: Role | 'demo', size: RoomSize, fits: (x: number, y: number) => boolean): { x: number; y: number }[] {
  const { w, h } = roomFootprint(kind, size);
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y + h <= CONFIG.grid.h; y++) {
    for (let x = 0; x + w <= CONFIG.grid.w; x++) {
      if (fits(x, y)) out.push({ x, y });
    }
  }
  return out;
}

/** All top-left cells where this room would fit on the floor (for the UI to highlight). */
export function validSpots(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1): { x: number; y: number }[] {
  return scanSpots(kind, size, (x, y) => canPlaceRoom(state, kind, size, floor, x, y).ok);
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
  let proceeds = assets.disposeDesksIn(state, room.id);
  if (room.kind === 'demo') {
    for (const a of state.assets.filter((x) => x.kind === 'demoRoom' && x.roomId === room.id)) proceeds += assets.dispose(state, a);
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

// ---------------------------------------------------------------- tournament helpers (DESIGN.md 0)

/** DESIGN.md 0: rooms open by themselves on the lowest free row first, leftmost on that row. */
function lowestRowFirst(spots: { x: number; y: number }[]): { x: number; y: number } | null {
  spots.sort((a, b) => b.y - a.y || a.x - b.x);
  return spots[0] ?? null;
}

/**
 * The spot a room of this kind would be auto-placed on: lowest row first, then leftmost; floor 0
 * before floor 1, on the floors that exist. The size is the one the ruleset opens (RULES.roomSize).
 */
export function autoSpot(state: GameState, kind: Role | 'demo', size: RoomSize = RULES.roomSize): { floor: 0 | 1; x: number; y: number } | null {
  for (const floor of [0, 1] as const) {
    if (floor >= state.floors) break;
    const first = lowestRowFirst(validSpots(state, kind, size, floor));
    if (first) return { floor, ...first };
  }
  return null;
}

/**
 * DESIGN.md 0 "Space (v2)": would the next room of this kind go on a second floor that is not built
 * yet? True when the rule is on, only the ground floor exists, nothing of this size fits on it any
 * more, and the room would fit on the empty floor above.
 */
export function wouldBuildUpstairs(state: GameState, kind: Role | 'demo', size: RoomSize = RULES.roomSize): boolean {
  if (!RULES.upstairs || state.floors !== 1) return false;
  if (autoSpot(state, kind, size)) return false;
  return scanSpots(kind, size, (x, y) => fitsOn(state, kind, size, 1, x, y).ok).length > 0;
}

/**
 * Make sure the role has a free desk: reuse one, add a desk to a room with capacity, or open a room
 * of RULES.roomSize on the next free spot (lobby appears with the first room). When the ground floor
 * is full and RULES.upstairs is on, the second floor is bought first (assets.buy, capex) and the
 * room goes upstairs (DESIGN.md 0 "Space (v2)"). Pays for the desk through assets.buy (capex).
 * Returns the room with the free seat, or null.
 */
export function ensureSeat(state: GameState, role: Role): Room | null {
  const seat = S.seatFor(state, role);
  if (seat) return seat;
  // DESIGN.md 5/6: the garage seats anyone, so its spare desk comes before a new room and its rent
  const withSpace = state.rooms.find((r) => S.roomAcceptsRole(r, role) && assets.canBuy(state, 'desk', r.id).ok);
  if (withSpace) {
    assets.buy(state, 'desk', withSpace.id);
    return withSpace;
  }
  const size = RULES.roomSize;
  let spot = autoSpot(state, role, size);
  if (!spot && wouldBuildUpstairs(state, role, size)) {
    if (!assets.canBuy(state, 'secondFloor').ok) return null;
    assets.buy(state, 'secondFloor');
    spot = autoSpot(state, role, size);
  }
  if (!spot) return null;
  if (!canPlaceRoom(state, role, size, spot.floor, spot.x, spot.y).ok) return null;
  const room = placeRoom(state, role, size, spot.floor, spot.x, spot.y);
  if (!assets.canBuy(state, 'desk', room.id).ok) return null;
  assets.buy(state, 'desk', room.id);
  return room;
}
