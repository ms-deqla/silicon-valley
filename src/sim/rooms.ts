/**
 * The building: grid placement, opening and closing rooms, the lobby, the demo room.
 * DESIGN.md section 5. STUB — to be implemented.
 */
import type { GameState, Role, Room, RoomSize, Verdict } from './types';
import { no } from './types';

export function roomFootprint(kind: Role | 'demo', size: RoomSize): { w: number; h: number } {
  void kind; void size;
  return { w: 2, h: 2 };
}

export function roomRent(kind: Role | 'demo', size: RoomSize): number {
  void kind; void size;
  return 0;
}

/** In bounds, no overlap with rooms/garage/lobby on that floor, floor exists, cash for the demo room, one demo room max. */
export function canPlaceRoom(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1, x: number, y: number): Verdict {
  void state; void kind; void size; void floor; void x; void y;
  return no('not implemented');
}

/** All top-left cells where this room would fit on the floor (for the UI to highlight). */
export function validSpots(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1): { x: number; y: number }[] {
  void state; void kind; void size; void floor;
  return [];
}

/**
 * Creates the room (rent starts at once). First department room also creates the rent-free lobby.
 * kind 'demo' records capex and creates the demoRoom asset linked to the room. Visual 'room' open.
 */
export function placeRoom(state: GameState, kind: Role | 'demo', size: RoomSize, floor: 0 | 1, x: number, y: number): Room {
  void state; void kind; void size; void floor; void x; void y;
  throw new Error('not implemented');
}

export function canCloseRoom(state: GameState, roomId: string): Verdict {
  void state; void roomId;
  return no('not implemented');
}

/**
 * Fires occupants with severance ('roomClosed'), sells desks in it at 60% of book (ledger.recordDisposal),
 * removes the room. Closing the demo room disposes the demoRoom asset. Garage and lobby cannot close.
 * Closing the Marketing room resets adBudget to 0.
 */
export function closeRoom(state: GameState, roomId: string): void {
  void state; void roomId;
}
