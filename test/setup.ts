/**
 * Vitest setup: the engine tests exercise every mechanic, so the test suite runs with
 * the full engine switched on. Tournament tests call `useTournamentRules()` in their
 * own beforeEach/afterEach to test the published ruleset.
 */
import { beforeEach } from 'vitest';
import { EVENT_TYPES, ROLES } from '../src/sim/types';
import { RULES } from '../src/sim/config';
import type { Rules } from '../src/sim/config';

const TOURNAMENT: Rules = JSON.parse(JSON.stringify(RULES)) as Rules;

export function useFullEngine(): void {
  RULES.roles = [...ROLES];
  RULES.raises = true;
  RULES.quits = true;
  RULES.loans = true;
  RULES.finance = true;
  RULES.rnd = true;
  RULES.adBudget = true;
  RULES.events = [...EVENT_TYPES];
}

/** The published ruleset, exactly as config.ts declares it. */
export function useTournamentRules(): void {
  Object.assign(RULES, JSON.parse(JSON.stringify(TOURNAMENT)) as Rules);
}

beforeEach(() => {
  useFullEngine();
});
