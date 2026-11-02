/**
 * Investor knocks, equity rounds, loans, maturity, prepayment. DESIGN.md section 10.
 * STUB — to be implemented.
 */
import type { Card, GameState, Verdict } from './types';
import { no } from './types';

/** Daily: loan maturity (card 'maturity'), desperation knock when runway < 2 months (cooldown), scheduled knock. */
export function dailyCapital(state: GameState): void {
  void state;
}

/**
 * Build and open a knock card (kind 'knock' or 'desperation'): amount, equity terms, loan terms, decline.
 * Loan choice disabled (with reason) without a Finance room or with a loan outstanding.
 * Returns null if a card is already open.
 */
export function openKnock(state: GameState, desperate: boolean): Card | null {
  void state; void desperate;
  return null;
}

/** Apply the chosen option of a knock / desperation / maturity card; clear state.card; schedule the next knock. */
export function resolveCapitalCard(state: GameState, card: Card, choiceId: string): void {
  void state; void card; void choiceId;
  state.card = null;
}

export function canPrepay(state: GameState): Verdict {
  void state;
  return no('not implemented');
}

/** ledger.recordLoanRepaid(principal); loan = null. */
export function prepayLoan(state: GameState): void {
  void state;
}
