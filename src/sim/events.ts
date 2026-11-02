/**
 * The six events and their effects. DESIGN.md section 11. STUB — to be implemented.
 */
import type { Card, EventType, GameState } from './types';

/** Daily: open the scheduled event when day ≥ nextEventDay (weighted by eligibility), reschedule. */
export function dailyEvents(state: GameState): void {
  void state;
}

/** Daily housekeeping of expiring effects (press multiplier reset etc.). */
export function dailyEffects(state: GameState): void {
  void state;
}

/** Open a specific event (or a weighted random eligible one). Returns null if none eligible or a card is open. */
export function openEvent(state: GameState, type?: EventType): Card | null {
  void state; void type;
  return null;
}

/** Apply the chosen option; clear state.card. */
export function resolveEventCard(state: GameState, card: Card, choiceId: string): void {
  void state; void card; void choiceId;
  state.card = null;
}
