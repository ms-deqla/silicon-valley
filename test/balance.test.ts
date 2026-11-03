/**
 * DESIGN.md 16, the fast version. Every strategy × 3 seeds × 24 months runs headless without
 * throwing; then the DESIGN 16 target list (balance at month 36, the pacing probes and the
 * five-year guard at month 60) is evaluated on the same 3 seeds with the very evaluator
 * `pnpm balance` prints, so the doc, the harness and this test can never disagree about what a
 * target means. The targets are medians over the seed set, so with 3 seeds this is a smoke
 * check; the 200-seed table is `pnpm balance` (scripts/balance.ts, 60 months by default).
 */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim';
import { balanced, idle, reckless, runStrategy, strategyList } from '../scripts/strategies';
import { TARGET, evaluateTargets, runRows, summarize } from '../scripts/balance';

const SEEDS = [1, 2, 3];
/** months every strategy plays in the no-throw check */
const MONTHS = 24;
const D = CONFIG.time.daysPerMonth;

describe('balance smoke', () => {
  for (const strategy of strategyList) {
    it.each(SEEDS)(`${strategy.name}: seed %i plays ${MONTHS} months without throwing`, (seed) => {
      const { state, trace, pacing } = runStrategy(seed, strategy, MONTHS, { drainVisuals: true });
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

describe('DESIGN.md 16 targets at small scale (3 seeds)', () => {
  // the balance targets are read at month 36, the pacing targets within the first 9 months, the five-year guard at month 60
  const horizon = TARGET.guardMonth;
  const summaries = [idle, balanced, reckless].map((s) => summarize(s.name, runRows(s, SEEDS, horizon), horizon));
  const targets = evaluateTargets(summaries, horizon);

  it('evaluates every target (nothing n/a) and nothing threw', () => {
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
