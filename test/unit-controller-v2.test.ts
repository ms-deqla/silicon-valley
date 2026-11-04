/**
 * The shell's controller, v2 (DESIGN.md 0, 18, 19, 20), headless under fake timers: the
 * clock is held until startClock (the tour runs over the frozen 10:00), a practice run
 * posts nothing to the board, cardWaitMs counts only the wall clock spent with a card open,
 * and the audio cues fire on the right state changes. Plus the result screen's copy line
 * (DESIGN.md 20), a pure function. The leaderboard and the audio are stubs; nothing here
 * touches the DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG, RULES, createGame } from '../src/sim';
import type { Card, GameState } from '../src/sim';
import type { Audio, Sfx } from '../src/ui/audio';
import { createController } from '../src/ui/controller';
import type { ControllerOptions, ShellController } from '../src/ui/controller';
import type { Leaderboard, LeaderUpdate } from '../src/ui/leaderboard';
import { copyText, shareLink } from '../src/ui/result';
import { useTournamentRules } from './setup';

const D = CONFIG.time.daysPerMonth;
const MONTH_MS = RULES.secondsPerMonth * 1000;
const ROUND_MS = RULES.roundSeconds * 1000;
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

function recorder(): Audio & { plays: Sfx[] } {
  const plays: Sfx[] = [];
  let enabled = true;
  return {
    plays,
    available: true,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      enabled = on;
    },
    start() {},
    play(sfx) {
      plays.push(sfx);
    },
    destroy() {},
  };
}

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

function make(opts: ControllerOptions & { posts?: LeaderUpdate[] } = {}): { c: ShellController; audio: Audio & { plays: Sfx[] }; posts: LeaderUpdate[] } {
  const posts = opts.posts ?? [];
  const audio = recorder();
  const c = createController(3, stubLeaderboard(posts), { audio, ...opts });
  return { c, audio, posts };
}

/** Ticks a month of wall clock at a time until the run ends, answering cards at once; returns the cards seen. */
function playOut(c: ShellController): number {
  let cards = 0;
  for (let guard = 0; c.state.status === 'playing' && guard < 100; guard++) {
    vi.advanceTimersByTime(MONTH_MS);
    c.tick(0);
    if (c.state.card && c.state.status === 'playing') {
      cards += 1;
      c.dispatch({ type: 'card', choiceId: freeChoice(c.state.card) });
    }
  }
  return cards;
}

describe('the controller, v2', () => {
  beforeEach(() => {
    useTournamentRules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the clock at 10:00 until startClock: no game day passes, no projection, the countdown is the whole round', () => {
    const { c } = make();
    quiet(c.state);
    expect(c.clockRunning).toBe(false);
    expect(c.remainingMs).toBe(ROUND_MS);
    expect(c.elapsedMs).toBe(0);
    vi.advanceTimersByTime(5 * MONTH_MS);
    expect(c.tick(0)).toBe(false);
    expect(c.state.day).toBe(0);
    expect(c.state.schedule.roundEndDay).toBeNull();
    expect(c.remainingMs).toBe(ROUND_MS);
    // the tour closes: the deadline is the round from now, not from the mount
    c.startClock();
    expect(c.clockRunning).toBe(true);
    expect(c.remainingMs).toBe(ROUND_MS);
    expect(c.tick(0)).toBe(false);
    expect(c.state.day).toBe(0);
    vi.advanceTimersByTime(MONTH_MS);
    expect(c.tick(0)).toBe(true);
    expect(c.state.day).toBe(D);
    expect(c.remainingMs).toBe(ROUND_MS - MONTH_MS);
    expect(c.elapsedMs).toBe(MONTH_MS);
    // a second startClock changes nothing
    c.startClock();
    expect(c.remainingMs).toBe(ROUND_MS - MONTH_MS);
  });

  it('the board can be used while the clock is held, and the buzzer still rings a full round after the start', () => {
    const { c, posts } = make();
    quiet(c.state);
    vi.advanceTimersByTime(60_000);
    expect(c.dispatch({ type: 'hireRole', role: 'product' }).ok).toBe(true);
    expect(c.state.day).toBe(0);
    c.startClock();
    const cards = playOut(c);
    expect(cards).toBe(0);
    expect(c.state.status).toBe('sold');
    expect(c.state.day).toBe((RULES.roundSeconds / RULES.secondsPerMonth) * D);
    expect(posts[posts.length - 1]).toMatchObject({ status: 'sold', month: c.state.history.length });
  });

  it('a practice run posts nothing to the board, and says so on the controller', () => {
    const scored = make();
    scored.c.startClock();
    playOut(scored.c);
    expect(scored.c.practice).toBe(false);
    expect(scored.posts.length).toBeGreaterThan(0);

    const { c, posts } = make({ practice: true });
    expect(c.practice).toBe(true);
    c.startClock();
    c.dispatch({ type: 'hireRole', role: 'product' });
    playOut(c);
    expect(c.state.status).toBe('sold');
    expect(c.state.result?.kind).toBe('sold');
    expect(posts).toEqual([]);
  });

  it('cardWaitMs grows only while a card is open', () => {
    const { c } = make();
    quiet(c.state);
    c.startClock();
    vi.advanceTimersByTime(MONTH_MS);
    c.tick(0);
    expect(c.cardWaitMs).toBe(0);
    expect(c.dispatch({ type: 'debug', op: 'knock' }).ok).toBe(true);
    expect(c.state.card?.kind).toBe('knock');
    vi.advanceTimersByTime(2 * MONTH_MS);
    c.tick(0);
    vi.advanceTimersByTime(500);
    c.tick(0);
    expect(c.cardWaitMs).toBe(2 * MONTH_MS + 500);
    expect(c.state.day).toBe(D);
    expect(c.dispatch({ type: 'card', choiceId: 'decline' }).ok).toBe(true);
    vi.advanceTimersByTime(3 * MONTH_MS);
    c.tick(0);
    c.tick(0);
    c.tick(0);
    expect(c.cardWaitMs).toBe(2 * MONTH_MS + 500);
    expect(c.state.day).toBeGreaterThan(D);
    // past the deadline the wait is not counted: that time belongs to the buzzer
    expect(c.dispatch({ type: 'debug', op: 'knock' }).ok).toBe(true);
    vi.advanceTimersByTime(ROUND_MS);
    c.tick(0);
    expect(c.state.status).toBe('sold');
    expect(c.cardWaitMs).toBeLessThan(ROUND_MS);
  });

  it('plays knock for an investor card, page for an event, click on board actions, buzzer at the end, each once', () => {
    const { c, audio } = make();
    quiet(c.state);
    c.startClock();
    expect(c.dispatch({ type: 'hireRole', role: 'product' }).ok).toBe(true);
    expect(audio.plays).toEqual(['click']);
    // a refused action is no click
    expect(c.dispatch({ type: 'fireRole', role: 'sales' }).ok).toBe(false);
    expect(audio.plays).toEqual(['click']);
    expect(c.dispatch({ type: 'fireRole', role: 'product' }).ok).toBe(true);
    expect(audio.plays).toEqual(['click', 'click']);

    expect(c.dispatch({ type: 'debug', op: 'knock' }).ok).toBe(true);
    expect(audio.plays).toEqual(['click', 'click', 'knock']);
    vi.advanceTimersByTime(MONTH_MS);
    c.tick(0);
    c.tick(0);
    expect(audio.plays).toEqual(['click', 'click', 'knock']);
    expect(c.dispatch({ type: 'card', choiceId: 'decline' }).ok).toBe(true);
    expect(audio.plays).toEqual(['click', 'click', 'knock']);

    expect(c.dispatch({ type: 'debug', op: 'event' }).ok).toBe(true);
    expect(c.state.card?.kind).toBe('event');
    expect(audio.plays[audio.plays.length - 1]).toBe('page');
    const card = c.state.card as Card;
    expect(c.dispatch({ type: 'card', choiceId: freeChoice(card) }).ok).toBe(true);

    const before = audio.plays.length;
    vi.advanceTimersByTime(ROUND_MS);
    for (let guard = 0; c.state.status === 'playing' && guard < 100; guard++) c.tick(0);
    expect(c.state.status).toBe('sold');
    expect(audio.plays.slice(before).filter((s) => s === 'buzzer')).toEqual(['buzzer']);
    expect(c.audio).toBe(audio);
  });

  it('plays coin when cash lands, at most once a second', () => {
    const { c, audio } = make();
    quiet(c.state);
    c.startClock();
    expect(c.dispatch({ type: 'debug', op: 'tenCustomers' }).ok).toBe(true);
    // two month closes in one wall-clock instant (a tab that was hidden): one coin
    vi.advanceTimersByTime(2 * MONTH_MS);
    c.tick(0);
    c.tick(0);
    expect(c.state.history.length).toBe(2);
    expect(audio.plays.filter((s) => s === 'coin')).toEqual(['coin']);
    // a second later, the next close coins again
    vi.advanceTimersByTime(MONTH_MS);
    c.tick(0);
    expect(c.state.history.length).toBe(3);
    expect(audio.plays.filter((s) => s === 'coin')).toEqual(['coin', 'coin']);
  });

  it('newGame starts the clock at once with a fresh deadline and resets the card wait', () => {
    const { c } = make();
    c.startClock();
    quiet(c.state);
    c.dispatch({ type: 'debug', op: 'knock' });
    vi.advanceTimersByTime(MONTH_MS);
    c.tick(0);
    expect(c.cardWaitMs).toBe(MONTH_MS);
    c.newGame(5);
    expect(c.clockRunning).toBe(true);
    expect(c.cardWaitMs).toBe(0);
    expect(c.remainingMs).toBe(ROUND_MS);
    expect(c.state.seed).toBe(5);
  });
});

describe('the copy line (DESIGN.md 20)', () => {
  it('reads "Silicon Valley, 4 Nov: $821k, 69% owned, 17 months. Beat me: <link>"', () => {
    const state = createGame(3);
    for (let i = 0; i < 17; i++) state.history.push(state.book);
    state.founderShare = 0.69;
    state.result = { kind: 'sold', day: 17 * D, offer: 1_190_000, founderShare: 0.69, debt: 0, score: 821_000, reason: '' };
    state.status = 'sold';
    const date = new Date(2026, 10, 4);
    expect(copyText(state, { date, link: 'https://example.test/play' })).toBe('Silicon Valley, 4 Nov: $821k, 69% owned, 17 months. Beat me: https://example.test/play');
    expect(copyText(state, { date, link: 'https://example.test/play', practice: true })).toBe('Silicon Valley, 4 Nov: $821k, 69% owned, 17 months (practice). Beat me: https://example.test/play');
    state.result = { kind: 'gameOver', day: 9 * D, offer: 0, founderShare: 0.69, debt: 0, score: 0, reason: '' };
    state.history.length = 9;
    expect(copyText(state, { date, link: 'x' })).toBe('Silicon Valley, 4 Nov: $0, 69% owned, 9 months (out of cash). Beat me: x');
  });

  it('the link carries the tournament code and drops the query the page was opened with', () => {
    expect(shareLink('', 'https://example.test/play?code=old#x')).toBe('https://example.test/play');
    expect(shareLink('riga cup', 'https://example.test/play')).toBe('https://example.test/play?code=riga%20cup');
    expect(shareLink('x', 'not a url')).toBe('not a url');
  });
});
