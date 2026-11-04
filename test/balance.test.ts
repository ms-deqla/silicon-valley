/**
 * DESIGN.md 16, the fast version. Every strategy × 3 seeds × 24 months runs headless without
 * throwing; then the two DESIGN 16 target lists are evaluated on 20 seeds with the very
 * evaluators `pnpm balance` prints, so the doc, the harness and this test can never disagree
 * about what a target means: the tournament targets (DESIGN.md 0 rules, the published game,
 * read at the buzzer: month 30) and the engine targets under the full engine (balance at month
 * 36, the pacing probes, the five-year guard at month 60). The targets are medians over the seed
 * set (3 seeds flip a month-granular median on one lucky run); the 200-seed tables are
 * `pnpm balance` and `pnpm balance --full` (scripts/balance.ts).
 *
 * The tournament player (tPlayer) is the coach's follower (DESIGN.md 18), so the tournament
 * targets measure the advice itself: they can only pass once the coach names actions.
 *
 * runStrategy plays every strategy under its own ruleset; the describe blocks still name the
 * ruleset they assert under (useTournamentRules / useFullEngine from test/setup.ts).
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, advise, createGame } from '../src/sim';
import { balanced, idle, reckless, runStrategy, strategyList, tDeclineAll, tIdle, tPlayer, tTakeAll } from '../scripts/strategies';
import { TARGET, TOURNAMENT_TARGET, evaluateTargets, evaluateTournamentTargets, runRows, summarize, summarizeTournament } from '../scripts/balance';
import { useFullEngine, useTournamentRules } from './setup';

const SEEDS = [1, 2, 3];
/** the seeds the two target lists are read on: enough for a median to mean something, still well under a second */
const TARGET_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
/** months every strategy plays in the no-throw check */
const MONTHS = 24;
const D = CONFIG.time.daysPerMonth;

describe('balance smoke', () => {
  for (const strategy of strategyList) {
    it.each(SEEDS)(`${strategy.name} (${strategy.engine}): seed %i plays ${MONTHS} months without throwing`, (seed) => {
      const { state, trace, pacing, coach } = runStrategy(seed, strategy, MONTHS, { drainVisuals: true, coach: true });
      expect(['playing', 'gameOver', 'sold']).toContain(state.status);
      expect(trace.length).toBe(state.history.length);
      if (state.status === 'playing') {
        expect(state.day).toBe(MONTHS * D);
        expect(trace.length).toBe(MONTHS);
      } else {
        expect(state.result, 'an ended game carries its result').not.toBeNull();
      }
      for (const row of trace) expect(Number.isFinite(row.value), `month ${row.month} value`).toBe(true);
      // milestones are days inside the run, cards are counted once each
      for (const day of [pacing.firstFeatureDay, pacing.firstCustomerDay, pacing.firstProspectDay, pacing.firstDealDay, pacing.firstKnockDay]) {
        if (day !== null) {
          expect(day).toBeGreaterThan(0);
          expect(day).toBeLessThanOrEqual(state.day);
        }
      }
      expect(pacing.cards.knock + pacing.cards.desperation + pacing.cards.event).toBeGreaterThanOrEqual(0);
      // a tournament strategy only ever does what the tournament screen offers (DESIGN.md 0)
      if (strategy.engine === 'tournament') {
        expect(state.actions.every((a) => ['hireRole', 'fireRole', 'buyAsset', 'buyDemoRoom', 'card'].includes(a.action.type))).toBe(true);
        expect(state.actions.every((a) => a.action.type !== 'buyAsset' || a.action.kind === 'server')).toBe(true);
        expect(state.loan).toBeNull();
      }
      // the coach's advice is counted on every day it names a dispatchable action; nobody takes more than that,
      // and tPlayer follows the coach exactly (DESIGN.md 18), whatever the coach says
      expect(coach.taken).toBeLessThanOrEqual(coach.dispatchable);
      if (strategy === tPlayer) expect(coach.taken, 'tPlayer takes every dispatchable advice').toBe(coach.dispatchable);
    }, 20_000);
  }

  it.each(SEEDS)('idle never goes game over: the founder alone, no rent, cash never falls (seed %i)', (seed) => {
    const { state, trace } = runStrategy(seed, idle, MONTHS, { drainVisuals: true });
    expect(state.status).not.toBe('gameOver');
    expect(trace.length).toBe(MONTHS);
    for (const row of trace) {
      expect(Number.isFinite(row.value), `month ${row.month} value`).toBe(true);
      expect(row.value, `month ${row.month}`).toBeGreaterThanOrEqual(0);
    }
    expect(state.people.length).toBe(1);
    expect(state.cash).toBeGreaterThanOrEqual(CONFIG.start.cash);
  }, 20_000);
});

describe('DESIGN.md 16 tournament targets at small scale (20 seeds)', () => {
  // the published game (DESIGN.md 0): the round is 30 game months and every target is read at the buzzer
  useTournamentRules();
  const horizon = TOURNAMENT_TARGET.month;
  const summaries = [tIdle, tPlayer, tTakeAll, tDeclineAll].map((s) => summarizeTournament(s.name, runRows(s, TARGET_SEEDS, horizon), horizon));
  const targets = evaluateTournamentTargets(summaries, horizon);
  // DESIGN.md 18 rule 2: with no feature and no engineer the coach says "hire an engineer", now
  const dayZero = advise(createGame(TARGET_SEEDS[0]));

  it('the coach names the first engineer on day 0 (DESIGN.md 18 rule 2): tPlayer follows it, so the targets below measure the advice', () => {
    expect(dayZero.action).toEqual({ type: 'hireRole', role: 'product' });
    expect(dayZero.urgency).toBe('now');
    const player = summaries.find((s) => s.name === 'tPlayer');
    expect(player?.adviceTaken, 'share of the coach\'s dispatchable advice tPlayer took').toBe(1);
  });

  it('evaluates every tournament target (nothing n/a) and nothing threw', () => {
    expect(targets.length).toBe(13);
    for (const t of targets) expect(t.pass, t.label).not.toBeNull();
    for (const s of summaries) expect(s.errors, `${s.name} runs that threw`).toBe(0);
  });

  for (const t of targets) {
    it(`${t.label} (actual: ${t.actual})`, () => {
      expect(t.pass, `${t.label}: ${t.actual}`).toBe(true);
    });
  }
});

describe('DESIGN.md 16 engine targets at small scale (20 seeds, full engine)', () => {
  // the balance targets are read at month 36, the pacing targets within the first 9 months, the five-year guard at month 60
  useFullEngine();
  const horizon = TARGET.guardMonth;
  const summaries = [idle, balanced, reckless].map((s) => summarize(s.name, runRows(s, TARGET_SEEDS, horizon), horizon));
  const targets = evaluateTargets(summaries, horizon);

  it('evaluates every engine target (nothing n/a) and nothing threw', () => {
    expect(targets.length).toBe(17);
    for (const t of targets) expect(t.pass, t.label).not.toBeNull();
    for (const s of summaries) expect(s.errors, `${s.name} runs that threw`).toBe(0);
  });

  for (const t of targets) {
    it(`${t.label} (actual: ${t.actual})`, () => {
      expect(t.pass, `${t.label}: ${t.actual}`).toBe(true);
    });
  }
});
