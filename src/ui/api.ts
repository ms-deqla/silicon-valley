/**
 * UI-side contract. The shell (controller, HUD, panels, cards) and the office
 * renderer (canvas) are built against these interfaces, in parallel.
 */
import type { Action, GameState, Role, RoomSize, Verdict, VisualEvent } from '../sim';

/** 0 = paused. 10 is debug only. */
export type Speed = 0 | 1 | 3 | 10;

export interface PlacementMode {
  kind: Role | 'demo';
  size: RoomSize;
  floor: 0 | 1;
  /** valid top-left cells, from sim validSpots */
  spots: { x: number; y: number }[];
}

export interface GameController {
  readonly state: GameState;
  speed: Speed;
  /** 0..1 progress through the current game day (for interpolation) */
  readonly dayProgress: number;

  /** Advance the clock by wall-clock ms; returns true when the sim state changed. Called every animation frame. */
  tick(dtMs: number): boolean;
  dispatch(action: Action): Verdict;
  can(action: Action): Verdict;
  /** Listeners fire after every state change (sim day, action, new game). */
  subscribe(listener: (state: GameState) => void): () => void;
  newGame(seed: number): void;
  /** Visual events since the last drain; the renderer calls this every frame. */
  drainVisuals(): VisualEvent[];

  /** Build-panel placement mode, highlighted by the renderer; taps on a valid spot dispatch placeRoom. */
  placement: PlacementMode | null;
  setPlacement(mode: PlacementMode | null): void;

  /** Renderer reports a room tap; the shell opens the room sheet. */
  selectRoom(roomId: string | null): void;
  readonly selectedRoomId: string | null;

  /** Transient toast shown by the shell. */
  toast(text: string, tone?: 'good' | 'bad' | 'info'): void;
}

export interface OfficeRenderer {
  /** Re-measure the canvas (CSS size × devicePixelRatio) */
  resize(): void;
  /** Draw one frame. */
  frame(dtMs: number): void;
  destroy(): void;
}
