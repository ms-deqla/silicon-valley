/**
 * The coach (DESIGN.md 18): the single best next action with a reason, and the
 * recommendation on an open card. Advice only; nothing here mutates state.
 * STUB — to be implemented.
 */
import type { Action, Card, GameState, Role } from './types';

export type Urgency = 'now' | 'soon' | 'idea';

export interface Advice {
  /** what to dispatch, or null when the advice is to wait */
  action: Action | null;
  /** short imperative, e.g. "Hire a rep" */
  label: string;
  /** one sentence with the numbers behind it */
  reason: string;
  urgency: Urgency;
  /** the board row or asset the advice points at, for the pulse */
  target: Role | 'server' | 'demo' | null;
}

export interface CardAdvice {
  choiceId: string;
  /** one sentence, e.g. "you have 2 months of cash left" */
  reason: string;
}

/** DESIGN.md 18, rules 2–11. Never returns null. */
export function advise(state: GameState): Advice {
  void state;
  return { action: null, label: 'Watch the lobby and the strip.', reason: '', urgency: 'idea', target: null };
}

/** DESIGN.md 18, rule 1. Null when the card has no recommendation. */
export function adviseCard(state: GameState, card: Card): CardAdvice | null {
  void state; void card;
  return null;
}
