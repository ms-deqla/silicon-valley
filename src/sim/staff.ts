/**
 * People: candidates, hiring, firing, morale, raises, quitting, learning.
 * DESIGN.md section 6. STUB — to be implemented.
 */
import type { Candidate, GameState, Person, Role, Verdict } from './types';
import { no } from './types';

/** Three fresh candidates for a role (archetype weights, skill ranges, salary noise, quirk, pitch). */
export function generateCandidates(state: GameState, role: Role): Candidate[] {
  void state; void role;
  return [];
}

/** Regenerate candidates for every role (called at creation and every month end). */
export function refreshCandidates(state: GameState): void {
  void state;
}

/** Needs: candidate exists, a free desk for the role (department room or garage), cash ≥ one month's salary. */
export function canHire(state: GameState, candidateId: string): Verdict {
  void state; void candidateId;
  return no('not implemented');
}

/** Creates the Person, seats them, hands out a laptop if spare, removes the candidate, logs, visual 'hire'. */
export function hire(state: GameState, candidateId: string): void {
  void state; void candidateId;
}

export function canFire(state: GameState, personId: string): Verdict {
  void state; void personId;
  return no('not implemented');
}

/**
 * Removes the person. 'fired' and 'roomClosed' pay severance (3 months' base salary);
 * 'quit' and 'poached' do not. Frees the desk and the laptop. Logs and pushes visual 'leave'.
 */
export function fire(state: GameState, personId: string, reason: 'fired' | 'quit' | 'poached' | 'roomClosed'): void {
  void state; void personId; void reason;
}

export function canRaise(state: GameState, personId: string): Verdict {
  void state; void personId;
  return no('not implemented');
}

/** Grant: +15% base salary, morale boost. Refuse: morale penalty. Clears the pending flag. */
export function resolveRaise(state: GameState, personId: string, grant: boolean): void {
  void state; void personId; void grant;
}

export function canSetFounderRole(state: GameState, role: 'product' | 'sales'): Verdict {
  void state; void role;
  return no('not implemented');
}

export function setFounderRole(state: GameState, role: 'product' | 'sales'): void {
  state.founderRole = role;
}

/** Target morale for a person from office conditions and quirks (DESIGN.md 6). */
export function moraleTarget(state: GameState, p: Person): number {
  void state; void p;
  return 70;
}

/** Daily: morale drifts toward target; pending raises older than raisePendingDays count as refused. */
export function dailyStaff(state: GameState): void {
  void state;
}

/** Monthly: learning, raise requests, quits, candidate refresh. */
export function monthlyStaff(state: GameState): void {
  void state;
}
