/**
 * The scaffold's smoke test, now that every module is live: a founder who never acts
 * plays a full year through the public API, with every investor knock and event card
 * answered by the idle strategy (declines the money, picks the free option), and the
 * books reconcile at every close.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, ledger } from '../src/sim';
import { idle, runStrategy } from '../scripts/strategies';

const D = CONFIG.time.daysPerMonth;
const MONTHS = 12;

describe('smoke', () => {
  it('runs 12 months with the founder alone and keeps the books reconciled', () => {
    const { state: s, trace } = runStrategy(42, idle, MONTHS, { drainVisuals: true });
    expect(s.status).toBe('playing');
    expect(s.day).toBe(MONTHS * D);
    expect(s.history).toHaveLength(MONTHS);
    expect(trace).toHaveLength(MONTHS);
    for (const b of s.history) expect(ledger.checkIdentities(b), `month ${b.month}`).toEqual([]);

    // DESIGN.md 6: the founder is free; DESIGN.md 5: the garage is rent-free. Nothing else exists,
    // so the only costs are the depreciation of the founding desk and laptop, and cash never falls.
    expect(s.people).toHaveLength(1);
    expect(s.rooms.map((r) => r.kind)).toEqual(['garage']);
    expect(s.rounds).toHaveLength(0);
    expect(s.loan).toBeNull();
    for (const b of s.history) {
      expect(b.pnl.salaries).toBe(0);
      expect(b.pnl.rent).toBe(0);
      expect(b.pnl.severance).toBe(0);
      expect(b.cf.capex).toBe(0);
      expect(b.fin.equityIn + b.fin.loanIn + b.fin.loanRepaid).toBe(0);
      expect(b.pnl.depreciation).toBeGreaterThan(0);
      expect(Number.isFinite(b.valueEnd)).toBe(true);
    }
    expect(s.cash).toBeGreaterThanOrEqual(CONFIG.start.cash);
    // the founder ships features on their own, so organic visitors can subscribe
    expect(s.features).toBeGreaterThan(0);
    expect(s.actions.every((a) => a.action.type === 'card')).toBe(true);
  });
});
