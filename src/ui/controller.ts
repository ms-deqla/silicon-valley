/**
 * The shell's handle on the simulation and on the round. Owns the GameState, the
 * fixed wall-clock → game-day conversion (DESIGN.md 0: one month per 20 s, no pause,
 * no speeds; game time is tied to the round clock, so a tab that was hidden catches up
 * when it returns), the ten-minute deadline and the buzzer, the leaderboard posts, and
 * the UI-only room highlight. Nothing in the UI mutates the sim except through
 * dispatch() here (CONTRIBUTING.md 7, DESIGN.md 14), with one exception that belongs to
 * the clock rather than to the player: the day the round will end on
 * (state.schedule.roundEndDay), which the sim's last-month knock blackout is measured
 * against (DESIGN.md 0).
 */
import { CONFIG, RULES, advanceDay, canDispatch, createGame, dispatch as simDispatch } from '../sim';
import type { Action, Card, GameState, Status, Verdict, VisualEvent } from '../sim';
import type { GameController, PlacementMode, Speed } from './api';
import type { Leaderboard, LeaderStatus } from './leaderboard';

export type Tone = 'good' | 'bad' | 'info';
export type Listener<T> = (value: T) => void;

/** GameController plus the shell-only parts: the round clock, the leaderboard, toasts. */
export interface ShellController extends GameController {
  readonly companyName: string;
  readonly playerName: string;
  readonly leaderboard: Leaderboard;
  /** Wall-clock ms left in the round, clamped at 0. The countdown never stops (DESIGN.md 0). */
  readonly remainingMs: number;
  /** Wall-clock ms since the round started, capped at the round length. */
  readonly elapsedMs: number;
  /** The round length in ms (RULES.roundSeconds). */
  readonly roundMs: number;
  onToast(listener: (text: string, tone: Tone) => void): () => void;
  /** Start over on a seed with a fresh deadline. The caller registers the run with the leaderboard first. */
  newGame(seed: number): void;
}

export interface ControllerOptions {
  companyName?: string;
  playerName?: string;
}

/** DESIGN.md 0: one game month per RULES.secondsPerMonth of wall clock, so one game day is this many ms. */
const DAY_MS = (RULES.secondsPerMonth * 1000) / CONFIG.time.daysPerMonth;
/**
 * A frame simulates at most this many days (one game month): a long backlog (a tab that
 * was hidden) is played out over a few frames so the page stays responsive, and none of
 * it is dropped (DESIGN.md 0: the clock never stops).
 */
const MAX_DAYS_PER_FRAME = 30;
/** Cards the buzzer may have to clear in a row (answering one can open the next, e.g. the crisis knock). */
const MAX_CARDS_AT_BUZZER = 4;
/** Speed is fixed in the tournament; the GameController contract still carries the field. */
const FIXED_SPEED: Speed = 1;

/**
 * The choice that costs nothing when the buzzer finds a card open: 'decline' on an
 * investor card; on an event the second choice (DESIGN.md 11: the free one).
 */
function freeChoice(card: Card): string | null {
  const open = card.choices.filter((c) => !c.disabled);
  const decline = open.find((c) => c.id === 'decline');
  if (decline) return decline.id;
  if (card.kind === 'event') {
    const second = card.choices[1];
    if (second && !second.disabled) return second.id;
  }
  return open.find((c) => c.id !== 'default')?.id ?? open[0]?.id ?? null;
}

function leaderStatus(status: Status): LeaderStatus {
  return status === 'playing' ? 'playing' : status === 'sold' ? 'sold' : 'dead';
}

export function createController(seed: number, leaderboard: Leaderboard, opts: ControllerOptions = {}): ShellController {
  let state: GameState = createGame(seed, opts.companyName ? { companyName: opts.companyName } : {});
  const name = state.companyName;
  const playerName = opts.playerName ?? '';
  const roundMs = RULES.roundSeconds * 1000;
  let startedAt = Date.now();
  let deadline = startedAt + roundMs;
  /** wall-clock ms of game time still to be simulated: the round clock's backlog */
  let backlog = 0;
  /** the round clock as of the last tick, never past the deadline; elapsed time joins the backlog from here */
  let clockedAt = startedAt;
  let selected: string | null = null;
  let postedMonth = -1;
  let postedStatus: Status | null = null;

  const listeners = new Set<Listener<GameState>>();
  const toastListeners = new Set<(text: string, tone: Tone) => void>();

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

  /**
   * DESIGN.md 0: value, month and status go to the leaderboard after every month close
   * and on every status change. It runs before the listeners, so the final standing is
   * posted before the result screen draws.
   */
  function postStanding(): void {
    const month = state.history.length;
    if (month === postedMonth && state.status === postedStatus) return;
    postedMonth = month;
    postedStatus = state.status;
    const value = Math.max(0, state.valuation.value);
    // the standing every run is ranked by: the final score, or what the buzzer would pay now (value × founder share)
    const score = state.result ? state.result.score : value * state.founderShare;
    leaderboard.post({ value, score, month, status: leaderStatus(state.status) });
  }

  function notify(): void {
    flushToastVisuals();
    postStanding();
    for (const l of listeners) l(state);
  }

  /**
   * The buzzer (DESIGN.md 0): a waiting card is answered with its free choice first,
   * because the sim refuses timeUp while a card is open; then the company is sold.
   * Returns true when the sim changed.
   */
  function buzzer(): boolean {
    const before = state.actions.length;
    for (let i = 0; state.card && state.status === 'playing' && i < MAX_CARDS_AT_BUZZER; i++) {
      const choiceId = freeChoice(state.card);
      if (!choiceId || !simDispatch(state, { type: 'card', choiceId }).ok) break;
    }
    if (state.status === 'playing' && !state.card) simDispatch(state, { type: 'timeUp' });
    backlog = 0;
    const changed = state.actions.length !== before;
    if (changed) notify();
    return changed;
  }

  /**
   * DESIGN.md 0: no scheduled knock opens in the last 30 game days of the round, and the
   * round ends at the buzzer, which rings before the nominal 30 months whenever a card
   * cost game months. The sim is told the day it will ring on: today plus the days still
   * to be played, the backlog (a hidden tab's unplayed days) and the wall clock left before
   * the deadline. Each simulated day moves one day from the backlog into state.day, so one
   * projection per tick holds through the frame's loop. Not an action, so not in the
   * action log: a replay() of a live round measures the blackout against the nominal end.
   */
  function projectRoundEnd(): void {
    state.schedule.roundEndDay = state.day + Math.floor((backlog + Math.max(0, deadline - clockedAt)) / DAY_MS);
  }

  /**
   * Game time is tied to the round clock (DESIGN.md 0: the clock never stops). The
   * wall-clock ms since the last tick, up to the deadline, join the backlog, which is
   * simulated at most MAX_DAYS_PER_FRAME days per frame: a tab that was hidden catches
   * up over a few frames instead of losing the months. A card stops game time and
   * drops the backlog, so the months a card costs are never refunded, during it or
   * after it. Once the deadline has passed and the backlog before it is played out,
   * the buzzer sounds, once. The frame delta is not used: the deadline is Date.now(),
   * so the game months and the countdown share one clock and cannot drift apart.
   */
  function tick(_dtMs: number): boolean {
    if (state.status !== 'playing') {
      backlog = 0;
      return false;
    }
    const now = Date.now();
    // nothing past the deadline is played: that time belongs to the buzzer
    const until = Math.min(now, deadline);
    const elapsed = Math.max(0, until - clockedAt);
    clockedAt = until;
    // A card stops game time (advanceDay refuses to move anyway); the deadline keeps running.
    if (state.card) {
      backlog = 0;
      projectRoundEnd();
      return now >= deadline ? buzzer() : false;
    }
    backlog += elapsed;
    projectRoundEnd();
    let days = 0;
    while (backlog >= DAY_MS && days < MAX_DAYS_PER_FRAME) {
      advanceDay(state);
      backlog -= DAY_MS;
      days += 1;
      if (state.card || state.status !== 'playing') {
        backlog = 0;
        break;
      }
    }
    if (now >= deadline && backlog < DAY_MS) {
      // the backlog before the deadline is played out (or a card stopped it): the buzzer, which notifies itself
      const rang = buzzer();
      if (!rang && days > 0) notify();
      return rang || days > 0;
    }
    if (days > 0) notify();
    return days > 0;
  }

  function dispatch(action: Action): Verdict {
    const v = simDispatch(state, action);
    if (!v.ok) {
      emitToast(v.reason ?? 'Not possible right now.', 'bad');
      return v;
    }
    notify();
    return v;
  }

  function newGame(newSeed: number): void {
    state = createGame(newSeed, { companyName: name });
    backlog = 0;
    selected = null;
    postedMonth = -1;
    postedStatus = null;
    startedAt = Date.now();
    deadline = startedAt + roundMs;
    clockedAt = startedAt;
    notify();
  }

  const controller: ShellController = {
    get state() {
      return state;
    },
    get speed() {
      return FIXED_SPEED;
    },
    set speed(_s: Speed) {
      // DESIGN.md 0: no pause, no speed buttons
    },
    get dayProgress() {
      return Math.max(0, Math.min(0.999, backlog / DAY_MS));
    },
    get placement() {
      // DESIGN.md 0: room placement is switched off; rooms place themselves
      return null;
    },
    set placement(_mode: PlacementMode | null) {
      // never enters placement mode
    },
    get selectedRoomId() {
      return selected;
    },
    get companyName() {
      return name;
    },
    get playerName() {
      return playerName;
    },
    get leaderboard() {
      return leaderboard;
    },
    get remainingMs() {
      return Math.max(0, deadline - Date.now());
    },
    get elapsedMs() {
      return Math.min(roundMs, Math.max(0, Date.now() - startedAt));
    },
    get roundMs() {
      return roundMs;
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
    setPlacement() {
      // DESIGN.md 0: no placement mode
    },
    selectRoom(roomId) {
      // no room sheet in the tournament: the renderer only highlights the tapped room
      selected = roomId;
    },
    toast: (text, tone = 'info') => emitToast(text, tone),
    onToast(listener) {
      toastListeners.add(listener);
      return () => {
        toastListeners.delete(listener);
      };
    },
  };
  return controller;
}
