/**
 * State → scene: room rectangles, desk slots, seated people and the anchor
 * points walkers steer by. Rebuilt only when the state or the layout changes,
 * never per frame. Pure: no DOM, no mutation of the state.
 * DESIGN.md section 5 (building) and 13 (crowd).
 */
import { CONFIG } from '../../sim/config';
import type { GameState, Role, Room, RoomKind } from '../../sim/types';
import * as S from '../../sim/selectors';
import { BACK_WALL, SIDE_WALL, doorAnchor, floorRect, rectOf, roomRect, stairPoints } from './layout';
import type { Layout, Rect } from './layout';
import { HAIR, ROOM_NAME, SKIN } from './palette';
import { hash01 } from './util';
import type { Pt } from './util';

export interface SeatInfo {
  personId: string;
  /** feet position of the seated figure */
  x: number;
  y: number;
  floor: 0 | 1;
  role: Role;
  founder: boolean;
  skin: number;
  hair: number;
  phase: number;
}

export interface RoomView {
  room: Room;
  rect: Rect;
  /** floor area inside the walls, below the back wall */
  interior: Rect;
  /** where a visitor stands when "visiting" the room */
  aisle: Pt;
  centre: Pt;
  plant: Pt;
  /** desk centres, one per possible desk */
  slots: Pt[];
  /** desks actually bought (drawn), ≤ slots.length */
  deskCount: number;
  seats: SeatInfo[];
  label: string;
  /** label width measured by the painter on first use; -1 until then */
  labelW: number;
}

export interface LobbyProps {
  reception: Rect;
  tray: Rect;
  /** right edge and centre line of the "Owed to you" sign */
  sign: Pt;
  /** coffee machine centre (drawn when a coffee machine is owned) */
  coffee: Pt;
}

export interface Anchors {
  streetY: number;
  leftX: number;
  rightX: number;
  door: Pt;
  doorOut: Pt;
  entry: Pt;
  lobbyPoint: Pt;
  waiting: Pt[];
  receptionFront: Pt;
  coinOrigin: Pt;
  tray: Pt;
  stairBottom: Pt | null;
  stairTop: Pt | null;
}

export interface Scene {
  cell: number;
  rooms: RoomView[];
  byId: Map<string, RoomView>;
  /** first room of each kind, floor 0 preferred */
  first: Partial<Record<RoomKind, RoomView>>;
  seats: Map<string, SeatInfo>;
  anchors: Anchors;
  /** the lobby's furniture, null before the lobby exists (the garage is the hall then) */
  lobby: LobbyProps | null;
  hasLobby: boolean;
  /** the room that plays the hall: lobby, else garage */
  hall: Rect;
  floor0: Rect;
  floor1: Rect | null;
  lotAll: Rect;
  servers: number;
  serversShort: number;
  coffee: boolean;
}

export function buildScene(state: GameState, l: Layout): Scene {
  const c = l.cell;
  const rooms: RoomView[] = [];
  const byId = new Map<string, RoomView>();
  const first: Partial<Record<RoomKind, RoomView>> = {};
  const seats = new Map<string, SeatInfo>();
  for (const room of state.rooms) {
    const view = buildRoomView(state, room, roomRect(l, room), c);
    rooms.push(view);
    byId.set(room.id, view);
    const prev = first[room.kind];
    if (!prev || prev.room.floor > room.floor) first[room.kind] = view;
    for (const s of view.seats) seats.set(s.personId, s);
  }
  const lobbyView = first.lobby;
  const hallView = lobbyView ?? first.garage;
  const g = CONFIG.grid.garage;
  const hall: Rect = hallView ? hallView.rect : rectOf(l, 0, g.x, g.y, g.w, g.h);
  const hasLobby = !!lobbyView;

  const lobby: LobbyProps | null = hasLobby
    ? {
        reception: { x: hall.x + 0.25 * c, y: hall.y + 0.78 * c, w: 0.78 * c, h: 0.26 * c },
        tray: { x: hall.x + hall.w - 0.62 * c, y: hall.y + 0.74 * c, w: 0.42 * c, h: 0.2 * c },
        sign: { x: hall.x + hall.w - 0.08 * c, y: hall.y + 0.52 * c },
        coffee: { x: hall.x + hall.w - 0.3 * c, y: hall.y + 1.3 * c },
      }
    : null;

  const streetY = l.streetTop + 0.36 * c;
  const door = doorAnchor(l, hasLobby);
  const sp = stairPoints(l);
  const rec = lobby ? lobby.reception : null;
  const anchors: Anchors = {
    streetY,
    leftX: l.x0 - 0.9 * c,
    rightX: l.x0 + l.lotW + 0.9 * c,
    door,
    doorOut: { x: door.x, y: streetY },
    entry: { x: door.x, y: door.y - 0.32 * c },
    lobbyPoint: { x: hall.x + hall.w / 2, y: hall.y + hall.h - 0.55 * c },
    waiting: [
      { x: hall.x + 0.3 * c, y: hall.y + hall.h - 0.28 * c },
      { x: hall.x + 0.62 * c, y: hall.y + hall.h - 0.2 * c },
      { x: hall.x + hall.w - 0.5 * c, y: hall.y + hall.h - 0.3 * c },
    ],
    receptionFront: rec
      ? { x: rec.x + rec.w / 2, y: rec.y + rec.h + 0.3 * c }
      : { x: hall.x + hall.w / 2, y: hall.y + hall.h - 0.55 * c },
    coinOrigin: rec
      ? { x: rec.x + rec.w / 2, y: rec.y - 0.05 * c }
      : { x: hall.x + hall.w / 2, y: hall.y + 0.75 * c },
    tray: lobby
      ? { x: lobby.tray.x + lobby.tray.w / 2, y: lobby.tray.y }
      : { x: hall.x + hall.w - 0.4 * c, y: hall.y + 0.75 * c },
    stairBottom: sp ? sp.bottom : null,
    stairTop: sp ? sp.top : null,
  };

  return {
    cell: c,
    rooms,
    byId,
    first,
    seats,
    anchors,
    lobby,
    hasLobby,
    hall,
    floor0: floorRect(l, 0),
    floor1: l.floors === 2 ? floorRect(l, 1) : null,
    lotAll: { x: l.x0, y: l.y0, w: l.lotW, h: l.lotH },
    servers: S.serversOwned(state),
    serversShort: S.serversShort(state),
    coffee: S.hasCoffee(state),
  };
}

/** Desk grid of a room: as many columns as the room is wide, rows to fit the max desks. */
export function slotGrid(room: Room): { cols: number; rows: number; max: number } {
  const max = S.roomMaxDesks(room);
  if (max <= 0) return { cols: 0, rows: 0, max: 0 };
  const cols = Math.max(1, Math.min(room.w, max));
  return { cols, rows: Math.ceil(max / cols), max };
}

function buildRoomView(state: GameState, room: Room, rect: Rect, c: number): RoomView {
  const sideW = SIDE_WALL * c;
  const backH = BACK_WALL * c;
  const interior: Rect = {
    x: rect.x + sideW + 0.08 * c,
    y: rect.y + backH + 0.02 * c,
    w: rect.w - 2 * sideW - 0.16 * c,
    h: rect.h - backH - 0.02 * c - 0.24 * c,
  };
  const grid = slotGrid(room);
  const slots: Pt[] = [];
  const pitch = grid.rows > 0 ? Math.max(0.7 * c, interior.h / grid.rows) : 0;
  for (let i = 0; i < grid.max; i++) {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    slots.push({ x: interior.x + ((col + 0.5) * interior.w) / grid.cols, y: interior.y + 0.42 * c + row * pitch });
  }
  const deskCount = Math.min(S.desksIn(state, room.id).length, slots.length);
  const occupants = S.occupantsOf(state, room.id);
  const seats: SeatInfo[] = [];
  for (let i = 0; i < occupants.length; i++) {
    const p = occupants[i];
    const slot = slots.length > 0 ? slots[i % slots.length] : { x: interior.x + interior.w / 2, y: interior.y + 0.42 * c };
    const overflow = slots.length > 0 ? Math.floor(i / slots.length) : i;
    seats.push({
      personId: p.id,
      x: slot.x - 0.06 * c + overflow * 0.14 * c,
      y: slot.y + 0.06 * c,
      floor: room.floor,
      role: S.roleOf(state, p),
      founder: p.founder,
      skin: Math.floor(hash01(p.id, 1) * SKIN.length),
      hair: Math.floor(hash01(p.id, 2) * HAIR.length),
      phase: hash01(p.id, 3) * Math.PI * 2,
    });
  }
  const plant: Pt = room.kind === 'lobby'
    ? { x: rect.x + sideW + 0.16 * c, y: rect.y + backH + 0.2 * c }
    : { x: rect.x + rect.w - sideW - 0.16 * c, y: rect.y + backH + 0.18 * c };
  return {
    room,
    rect,
    interior,
    aisle: { x: rect.x + rect.w / 2, y: rect.y + rect.h - 0.16 * c },
    centre: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    plant,
    slots,
    deskCount,
    seats,
    label: ROOM_NAME[room.kind],
    labelW: -1,
  };
}
