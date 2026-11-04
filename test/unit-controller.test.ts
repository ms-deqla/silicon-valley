/**
 * The shell's controller against the sim, headless under fake timers: the round clock's
 * projection of the day the buzzer will ring (state.schedule.roundEndDay). DESIGN.md 0:
 * cards cost game months, so the last-month knock blackout is measured against the
 * buzzer, not the nominal 30 months. The leaderboard is a stub; nothing here touches the
 * DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, RULES } from '../src/sim';
import type { Card, GameState } from '../src/sim';
import type { Audio } from '../src/ui/audio';
import { createController } from '../src/ui/controller';
import type { ShellController } from '../src/ui/controller';
import type { Leaderboard, LeaderUpdate } from '../src/ui/leaderboard';
import { useTournamentRules } from './setup';

/** A silent audio: nothing here listens to the cues (test/unit-controller-v2.test.ts does). */
const silent: Audio = { available: false, enabled: false, setEnabled() {}, start() {}, play() {}, destroy() {} };

/** A controller with the clock started at once (the v2 tour is not part of these tests). */
function running(seed: number, posts: LeaderUpdate[] = []): ShellController {
  const c = createController(seed, stubLeaderboard(posts), { audio: silent });
  c.startClock();
  return c;
}

const D = CONFIG.time.daysPerMonth;
const MONTH_MS = RULES.secondsPerMonth * 1000;
/** the nominal round in game days (DESIGN.md 0: 30 months) */
const ROUND_DAYS = (RULES.roundSeconds / RULES.secondsPerMonth) * D;
const FAR = 1_000_000;

function stubLeaderboard(posts: LeaderUpdate[] = []): Leaderboard {
  return {
    ready: Promise.resolve(),
    shared: false,
    canWrite: true,
    watch() {},
    start: async () => {},
    post(update) {
      posts.push(update);
    },
    subscribe: () => () => {},
    destroy() {},
  };
}

/** The choice that costs nothing (the buzzer's own rule): decline an investor, the second choice of an event. */
function freeChoice(card: Card): string {
  const open = card.choices.filter((c) => !c.disabled);
  const decline = open.find((c) => c.id === 'decline');
  if (decline) return decline.id;
  const second = card.choices[1];
  if (card.kind === 'event' && second && !second.disabled) return second.id;
  if (!open[0]) throw new Error('a card with no open choice');
  return open[0].id;
}

/** Push every scheduled card away, so only the clock and the cards the test opens move anything. */
function quiet(state: GameState): void {
  state.schedule.nextKnockDay = FAR;
  state.schedule.nextEventDay = FAR;
}

describe('the round clock projects the day the buzzer rings (DESIGN.md 0)', () => {
  beforeEach(() => {
    useTournamentRules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the nominal round until a card costs months, and the sim sees it before the first day is played', () => {
    const c = running(3);
    quiet(c.state);
    expect(c.state.schedule.roundEndDay).toBeNull();
    expect(c.tick(0)).toBe(false);
    expect(c.state.schedule.roundEndDay).toBe(ROUND_DAYS);
    vi.advanceTimersByTime(MONTH_MS);
    expect(c.tick(0)).toBe(true);
    expect(c.state.day).toBe(D);
    expect(c.state.schedule.roundEndDay).toBe(ROUND_DAYS);
  });

  it('a card left open for two months pulls the end two months closer, and the buzzer rings on the projected day', () => {
    const posts: LeaderUpdate[] = [];
    const c = running(3, posts);
    c.tick(0);
    expect(c.dispatch({ type: 'debug', op: 'knock' }).ok).toBe(true);
    expect(c.state.card?.kind).toBe('knock');
    vi.advanceTimersByTime(2 * MONTH_MS);
    expect(c.tick(0)).toBe(false);
    expect(c.state.day).toBe(0);
    expect(c.state.schedule.roundEndDay).toBe(ROUND_DAYS - 2 * D);
    expect(c.dispatch({ type: 'card', choiceId: 'decline' }).ok).toBe(true);

    // the rest of the round, a month of wall clock per tick, on the real schedule of knocks and events;
    // a card is answered at once, and still costs the rest of the month it opened in
    let projected = c.state.schedule.roundEndDay as number;
    let cards = 0;
    for (let guard = 0; c.state.status === 'playing' && guard < 100; guard++) {
      vi.advanceTimersByTime(MONTH_MS);
      c.tick(0);
      if (c.state.card && c.state.status === 'playing') {
        cards += 1;
        expect(c.dispatch({ type: 'card', choiceId: freeChoice(c.state.card) }).ok).toBe(true);
        continue;
      }
      const next = c.state.schedule.roundEndDay as number;
      expect(next).toBeLessThanOrEqual(projected);
      projected = next;
    }
    expect(cards).toBeGreaterThan(0);
    expect(c.state.status).toBe('sold');
    expect(c.state.day).toBe(projected);
    expect(c.state.day).toBeLessThanOrEqual(ROUND_DAYS - 2 * D);
    expect(c.remainingMs).toBe(0);
    expect(posts[posts.length - 1]).toMatchObject({ status: 'sold', month: c.state.history.length });
  });

  it('a scheduled knock due inside the last 30 days before the buzzer never opens, though the nominal calendar has months left', () => {
    const c = running(3);
    quiet(c.state);
    c.tick(0);
    // three months go to an open card: the buzzer will ring on day 810, not 900
    expect(c.dispatch({ type: 'debug', op: 'knock' }).ok).toBe(true);
    vi.advanceTimersByTime(3 * MONTH_MS);
    c.tick(0);
    expect(c.dispatch({ type: 'card', choiceId: 'decline' }).ok).toBe(true);
    expect(c.state.schedule.knocks).toBe(1);
    const end = ROUND_DAYS - 3 * D;
    expect(c.state.schedule.roundEndDay).toBe(end);

    // due with 10 days left before the buzzer (100 before the nominal end): held back for good
    c.state.schedule.nextKnockDay = end - 10;
    for (let guard = 0; c.state.status === 'playing' && guard < 100; guard++) {
      vi.advanceTimersByTime(MONTH_MS);
      c.tick(0);
      if (c.state.status === 'playing') expect(c.state.card).toBeNull();
    }
    expect(c.state.status).toBe('sold');
    expect(c.state.day).toBe(end);
    expect(c.state.schedule.knocks).toBe(1);

    // the same due day on a round that lost no months is 100 days before the buzzer: the knock opens
    const full = running(3);
    quiet(full.state);
    full.tick(0);
    full.state.schedule.nextKnockDay = end - 10;
    for (let guard = 0; full.state.status === 'playing' && !full.state.card && guard < 100; guard++) {
      vi.advanceTimersByTime(MONTH_MS);
      full.tick(0);
    }
    expect(full.state.card?.kind).toBe('knock');
    expect(full.state.day).toBe(end - 10);
    expect(full.state.schedule.knocks).toBe(1);
  });
});
