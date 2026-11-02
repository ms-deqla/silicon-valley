/**
 * The shell's handle on the simulation. Owns the GameState, the wall clock → game
 * day conversion, and the UI-only selection / placement state. Nothing in the UI
 * mutates the sim except through dispatch() here (CONTRIBUTING.md 7, DESIGN.md 14).
 */
import { advanceDay, canDispatch, createGame, dispatch as simDispatch } from '../sim';
import type { Action, GameState, Verdict, VisualEvent } from '../sim';
import type { GameController, PlacementMode, Speed } from './api';

export type Tone = 'good' | 'bad' | 'info';
export type Listener<T> = (value: T) => void;

/** GameController plus the shell-only hooks (toasts, selection and placement changes). */
export interface ShellController extends GameController {
  readonly companyName: string;
  /** Pause ⇄ the last running speed (space bar). */
  togglePause(): void;
  onToast(listener: (text: string, tone: Tone) => void): () => void;
  onSelect(listener: Listener<string | null>): () => void;
  onPlacement(listener: Listener<PlacementMode | null>): () => void;
  /** Start over with a seed; the company name is kept unless a new one is given. */
  newGame(seed: number, companyName?: string): void;
}

/** One game day = 1000 ms at 1× (DESIGN.md 4: a 30-day month is 30 s). */
const DAY_MS = 1000;
/** A long frame (hidden tab) advances at most this many days; the rest of the backlog is dropped. */
const MAX_DAYS_PER_FRAME = 5;

export function createController(seed: number, companyName?: string): ShellController {
  let state: GameState = createGame(seed, companyName ? { companyName } : {});
  let name = state.companyName;
  let speed: Speed = 1;
  let lastRunning: Speed = 1;
  /** wall-clock ms accumulated toward the next game day */
  let acc = 0;
  let placement: PlacementMode | null = null;
  let selected: string | null = null;

  const listeners = new Set<Listener<GameState>>();
  const toastListeners = new Set<(text: string, tone: Tone) => void>();
  const selectListeners = new Set<Listener<string | null>>();
  const placementListeners = new Set<Listener<PlacementMode | null>>();

  function emitToast(text: string, tone: Tone): void {
    for (const l of toastListeners) l(text, tone);
  }

  /** The shell owns toasts (DESIGN.md 13), so 'toast' visuals are pulled out of the renderer queue here. */
  function flushToastVisuals(): void {
    if (!state.visuals.some((v) => v.t === 'toast')) return;
    const keep: VisualEvent[] = [];
    for (const v of state.visuals) {
      if (v.t === 'toast') emitToast(v.text, v.tone);
      else keep.push(v);
    }
    state.visuals.length = 0;
    for (const v of keep) state.visuals.push(v);
  }

  function notify(): void {
    flushToastVisuals();
    for (const l of listeners) l(state);
  }

  function setSpeed(s: Speed): void {
    speed = s;
    if (s > 0) lastRunning = s;
  }

  function setPlacement(mode: PlacementMode | null): void {
    placement = mode;
    for (const l of placementListeners) l(mode);
  }

  function selectRoom(roomId: string | null): void {
    if (roomId === null && selected === null) return;
    selected = roomId;
    for (const l of selectListeners) l(roomId);
  }

  function tick(dtMs: number): boolean {
    // The clock stops by itself while a card is open or after the game ended (advanceDay returns early).
    if (speed === 0 || state.status !== 'playing' || state.card) {
      acc = 0;
      return false;
    }
    const dayMs = DAY_MS / speed;
    acc += Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
    let days = 0;
    while (acc >= dayMs && days < MAX_DAYS_PER_FRAME) {
      advanceDay(state);
      acc -= dayMs;
      days += 1;
      if (state.card || state.status !== 'playing') {
        acc = 0;
        break;
      }
    }
    if (acc >= dayMs) acc = acc % dayMs; // backlog beyond the cap is dropped, not replayed
    if (days > 0) notify();
    return days > 0;
  }

  function dispatch(action: Action): Verdict {
    const v = simDispatch(state, action);
    if (!v.ok) {
      emitToast(v.reason ?? 'Not possible right now.', 'bad');
      return v;
    }
    if (action.type === 'placeRoom') setPlacement(null);
    if (action.type === 'closeRoom' && selected === action.roomId) selectRoom(null);
    notify();
    return v;
  }

  function newGame(newSeed: number, newName?: string): void {
    if (newName) name = newName;
    state = createGame(newSeed, { companyName: name });
    acc = 0;
    setSpeed(1);
    if (placement) setPlacement(null);
    if (selected !== null) selectRoom(null);
    notify();
  }

  const controller: ShellController = {
    get state() {
      return state;
    },
    get speed() {
      return speed;
    },
    set speed(s: Speed) {
      setSpeed(s);
    },
    get dayProgress() {
      const s = speed || lastRunning;
      return Math.max(0, Math.min(0.999, acc / (DAY_MS / s)));
    },
    get placement() {
      return placement;
    },
    set placement(mode: PlacementMode | null) {
      setPlacement(mode);
    },
    get selectedRoomId() {
      return selected;
    },
    get companyName() {
      return name;
    },
    tick,
    dispatch,
    can: (action) => canDispatch(state, action),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    newGame,
    drainVisuals() {
      if (state.visuals.length === 0) return [];
      return state.visuals.splice(0, state.visuals.length);
    },
    setPlacement,
    selectRoom,
    toast: (text, tone = 'info') => emitToast(text, tone),
    togglePause() {
      setSpeed(speed === 0 ? lastRunning : 0);
    },
    onToast(listener) {
      toastListeners.add(listener);
      return () => {
        toastListeners.delete(listener);
      };
    },
    onSelect(listener) {
      selectListeners.add(listener);
      return () => {
        selectListeners.delete(listener);
      };
    },
    onPlacement(listener) {
      placementListeners.add(listener);
      return () => {
        placementListeners.delete(listener);
      };
    },
  };
  return controller;
}
