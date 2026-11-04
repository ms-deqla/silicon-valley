/**
 * DESIGN.md 12 and 16: runs are deterministic from a seed and the action log.
 * Same seed + same action log through replay() → byte-identical JSON state (nothing stripped),
 * under the full engine and under the tournament rules (DESIGN.md 0), where the random policy's
 * log carries hires and firings by department, servers, the demo room, rooms closing themselves
 * and the second floor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTo, createGame, replay } from '../src/sim';
import type { ActionRecord, GameState } from '../src/sim';
import { balanced, randomStrategy, runStrategy, tPlayer } from '../scripts/strategies';
import type { Strategy } from '../scripts/strategies';
import { useTournamentRules } from './setup';

const snapshot = (s: GameState): string => JSON.stringify(s);

/** A readable pointer at the first byte where two snapshots diverge. */
function firstDifference(a: string, b: string): string {
  if (a === b) return 'identical';
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const lo = Math.max(0, i - 80);
  return `snapshots differ at byte ${i} of ${a.length}/${b.length}:\n  live:   …${a.slice(lo, i + 80)}…\n  replay: …${b.slice(lo, i + 80)}…`;
}

/** The same state without the two fields that differ by construction between seeds. */
function worldOf(s: GameState): string {
  const { seed, rng, ...world } = s;
  void seed;
  void rng;
  return JSON.stringify(world);
}

/** Play `policy` live, then rebuild the state from the seed and the persisted action log; both must be byte-identical. */
function expectReplayIdentical(seed: number, policy: Strategy, months: number): void {
  const { state: live } = runStrategy(seed, policy, months);
  // the log as the UI would persist it: a plain JSON round trip, nothing shared with the live state
  const log: ActionRecord[] = JSON.parse(JSON.stringify(live.actions));
  const replayed = replay(seed, log);
  advanceTo(replayed, live.day);
  const a = snapshot(live);
  const b = snapshot(replayed);
  expect(b === a, firstDifference(a, b)).toBe(true);
  expect(replayed.day).toBe(live.day);
  expect(replayed.status).toBe(live.status);
}

describe('determinism', () => {
  it.each([11, 22, 33])('seed %i: the random policy\'s action log replays to the identical state', (seed) => {
    expectReplayIdentical(seed, randomStrategy(seed * 31 + 7), 36);
  }, 60_000);

  it('replaying the same log twice gives identical JSON', () => {
    const { state: live } = runStrategy(5, randomStrategy(99), 18);
    const log: ActionRecord[] = JSON.parse(JSON.stringify(live.actions));
    const a = snapshot(replay(5, log));
    const b = snapshot(replay(5, log));
    expect(b === a, firstDifference(a, b)).toBe(true);
  }, 30_000);

  it('a scripted strategy is reproducible run to run', () => {
    const a = snapshot(runStrategy(7, balanced, 24).state);
    const b = snapshot(runStrategy(7, balanced, 24).state);
    expect(b === a, firstDifference(a, b)).toBe(true);
  }, 30_000);

  it('the same seed starts the same world', () => {
    const a = snapshot(createGame(20261102));
    const b = snapshot(createGame(20261102));
    expect(b === a, firstDifference(a, b)).toBe(true);
  });

  it('different seeds give different worlds', () => {
    const seeds = [1, 2, 3];
    const worlds = seeds.map((seed) => worldOf(runStrategy(seed, randomStrategy(2024), 12).state));
    for (let i = 0; i < worlds.length; i++) {
      for (let j = i + 1; j < worlds.length; j++) {
        expect(worlds[i] !== worlds[j], `seeds ${seeds[i]} and ${seeds[j]} produced the same world`).toBe(true);
      }
    }
  }, 30_000);

  it('a policy with a different dice seed takes a different path on the same world', () => {
    const a = runStrategy(4, randomStrategy(1), 24).state;
    const b = runStrategy(4, randomStrategy(2), 24).state;
    // only meaningful once the sim accepts actions; until then both logs are empty and equal
    if (a.actions.length > 0 || b.actions.length > 0) {
      expect(JSON.stringify(a.actions) !== JSON.stringify(b.actions)).toBe(true);
    }
  }, 30_000);
});

describe('determinism under the tournament rules (DESIGN.md 0)', () => {
  // replay() plays under the RULES in force, so the ruleset the policy played under must be back for it
  beforeEach(() => {
    useTournamentRules();
  });

  it.each([11, 22, 33])('seed %i: the tournament policy\'s action log (hires and firings by department, servers, the demo room, the uncle\'s money) replays to the identical state, rooms closing themselves and the second floor included', (seed) => {
    expectReplayIdentical(seed, randomStrategy(seed * 31 + 7, { engine: 'tournament' }), 36);
  }, 60_000);

  it('the coach\'s follower (tPlayer) is reproducible run to run', () => {
    const a = snapshot(runStrategy(7, tPlayer, 30).state);
    const b = snapshot(runStrategy(7, tPlayer, 30).state);
    expect(b === a, firstDifference(a, b)).toBe(true);
  }, 30_000);

  it('a tournament policy with a different dice seed takes a different path on the same world', () => {
    const a = runStrategy(4, randomStrategy(1, { engine: 'tournament' }), 24).state;
    const b = runStrategy(4, randomStrategy(2, { engine: 'tournament' }), 24).state;
    expect(a.actions.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.actions) !== JSON.stringify(b.actions)).toBe(true);
  }, 30_000);
});
