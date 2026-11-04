/**
 * What the run teaches (DESIGN.md 20): the takeaways with the biggest impact, and the
 * timeline of the stake. Pure reads of a finished (or running) state.
 * STUB — to be implemented.
 */
import type { GameState } from './types';

export interface RunExtras {
  /** wall-clock milliseconds with a card open, from the controller */
  cardWaitMs: number;
  practice: boolean;
}

export interface Takeaway {
  title: string;
  detail: string;
  /** rough $ impact, used to pick the top three */
  impact: number;
}

export interface TimelinePoint {
  month: number;
  value: number;
  share: number;
  stake: number;
}

export type MarkerKind = 'hire' | 'fire' | 'round' | 'event' | 'server' | 'demo' | 'upstairs';

export interface TimelineMarker {
  day: number;
  kind: MarkerKind;
  label: string;
}

/** The three takeaways with the highest impact (fewer when the run has less to say). */
export function takeaways(state: GameState, extras: RunExtras): Takeaway[] {
  void state; void extras;
  return [];
}

export function timeline(state: GameState): { points: TimelinePoint[]; markers: TimelineMarker[] } {
  void state;
  return { points: [], markers: [] };
}
