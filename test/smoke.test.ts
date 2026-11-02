import { describe, expect, it } from 'vitest';
import { createGame, advanceTo, ledger } from '../src/sim';

describe('skeleton', () => {
  it('runs 12 months with the stubs and keeps the books reconciled', () => {
    const s = createGame(42);
    advanceTo(s, 360);
    expect(s.day).toBe(360);
    expect(s.history.length).toBe(12);
    for (const b of s.history) expect(ledger.checkIdentities(b)).toEqual([]);
    expect(s.cash).toBe(50_000); // founder is free, garage is rent-free, nothing else exists yet
  });
});
