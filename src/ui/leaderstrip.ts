/**
 * The live leaderboard strip between the hint line and the office (DESIGN.md 0): the
 * top four players on today's world plus you when you are not among them, in the live
 * order (by what the buzzer would pay now). Subscribes once and draws only when the
 * entries change. Also home of the words every leaderboard view uses for an entry (its
 * status, the number it is ranked by, the mark that says what that number is), of the
 * best-of-the-day table the start and result screens show, and of the store caption
 * ("Local only", "Leaderboard may be out of date").
 */
import { money } from './format';
import { bestOf, sortEntriesByBest } from './leaderboard';
import type { LeaderEntry, Leaderboard } from './leaderboard';
import { h } from './panels/dom';

export interface LeaderStrip {
  el: HTMLElement;
  destroy(): void;
}

/** Players shown before "… you" is appended. */
const TOP = 4;

/** "Sold" / "Out of cash" / "Playing · month 7". */
export function entryStatus(e: LeaderEntry): string {
  if (e.status === 'sold') return 'Sold';
  if (e.status === 'dead') return 'Out of cash';
  return `Playing · month ${e.month}`;
}

/** The standing every run is ranked by live: the score once finished, value × founder share while playing. */
export function entryAmount(e: LeaderEntry): string {
  return money(e.score);
}

/**
 * What a shown number is: the standing of a run still going ('now'), a finished run's
 * score ('done' for sold, 'out' for out of cash), or the day's best from an earlier run ('best').
 */
export type Mark = 'now' | 'done' | 'out' | 'best';

export function markOf(e: LeaderEntry): Mark {
  return e.status === 'playing' ? 'now' : e.status === 'sold' ? 'done' : 'out';
}

const MARK_TEXT: Record<Mark, string> = { now: 'now', done: '✓', out: 'out', best: 'best' };
const MARK_TITLE: Record<Mark, string> = {
  now: 'What the buzzer would pay now',
  done: 'Finished: the buzzer sold the company',
  out: 'Out of cash: scores 0',
  best: "This player's best score today",
};

function markEl(m: Mark, cls: string): HTMLElement {
  return h('span', { class: `${cls} ${m}`, text: MARK_TEXT[m], title: MARK_TITLE[m] });
}

/**
 * The caption a leaderboard view shows once `ready` resolved: where the list comes from
 * when it is not the shared store, or that the store has not confirmed it (db contract:
 * no snapshot within 10 s); empty when the shared list is fresh.
 */
export function storeCaption(lb: Leaderboard): string {
  if (!lb.shared) return lb.canWrite ? 'Local only' : 'Leaderboard unavailable';
  return lb.stale ? 'Leaderboard may be out of date' : '';
}

/** The start and result screens' wording of the caption. */
export function longCaption(text: string): string {
  return text === 'Local only' ? "Local only: this browser's player." : text;
}

/**
 * Keeps a caption element in step with the store: hidden until `ready` resolves, then
 * storeCaption (through `wording`) on every change of the list, so "may be out of date"
 * comes and goes with the store's freshness. Returns the unsubscribe.
 */
export function watchCaption(lb: Leaderboard, el: HTMLElement, wording: (text: string) => string = (t) => t): () => void {
  let settled = false;
  let alive = true;
  const refresh = (): void => {
    if (!settled || !alive) return;
    const text = storeCaption(lb);
    el.textContent = text ? wording(text) : '';
    el.hidden = !text;
  };
  const off = lb.subscribe(refresh);
  void lb.ready.then(() => {
    settled = true;
    refresh();
  });
  return () => {
    alive = false;
    off();
  };
}

/**
 * The best-of-the-day table (start screen preview, result screen): rank, name, the
 * number each player is ranked by (a finished player's best score today; a run still
 * going by its standing, or by its earlier best when that is higher) with its mark,
 * status; the local player highlighted. Names come from other players, so they are set
 * as text, never markup.
 */
export function leaderTable(entries: LeaderEntry[]): HTMLElement {
  if (entries.length === 0) return h('p', { class: 'lb-empty', text: "Nobody on today's world yet. Be the first." });
  const rows = sortEntriesByBest(entries).map((e, i) => {
    const amount = bestOf(e);
    const m: Mark = amount > e.score ? 'best' : markOf(e);
    return h('tr', { class: e.me ? 'me' : '' },
      h('td', { text: String(i + 1) }),
      h('td', { class: 'lb-name', text: e.name, title: e.name }),
      h('td', { class: `lb-score${m === 'now' ? ' muted' : ''}` }, h('span', { text: money(amount) }), markEl(m, 'lb-mark')),
      h('td', { text: entryStatus(e) }));
  });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table lb' },
    h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Name' }), h('th', { text: 'Score' }), h('th', { text: 'Status' }))),
    h('tbody', {}, ...rows)));
}

export function createLeaderStrip(leaderboard: Leaderboard): LeaderStrip {
  const list = h('div', { class: 'ls-list' });
  const caption = h('span', { class: 'ls-caption' });
  caption.hidden = true;
  const el = h('div', { class: 'leaderstrip', attrs: { 'aria-label': 'Live leaderboard' } },
    h('span', { class: 'ls-live', text: 'LIVE' }), list, caption);

  /** Rank, name, the live standing with its mark, and the day's best when an earlier run did better. */
  function chip(e: LeaderEntry, rank: number): HTMLElement {
    const m = markOf(e);
    const better = e.best > e.score;
    return h('span', {
      class: `ls-chip${e.me ? ' me' : ''}${m !== 'now' ? ' done' : ''}`,
      title: `${e.name} · ${entryStatus(e)} · ${m === 'now' ? 'now' : 'score'} ${entryAmount(e)}${better ? ` · best today ${money(e.best)}` : ''}`,
    },
    h('b', { class: 'ls-rank', text: String(rank) }),
    h('span', { class: 'ls-name', text: e.name }),
    h('span', { class: 'ls-val', text: entryAmount(e) }),
    markEl(m, 'ls-mark'),
    better ? h('small', { class: 'ls-best', text: `best ${money(e.best)}` }) : null);
  }

  function render(entries: LeaderEntry[]): void {
    list.replaceChildren();
    if (entries.length === 0) {
      list.appendChild(h('span', { class: 'ls-empty', text: "Nobody on today's world yet" }));
      return;
    }
    const top = entries.slice(0, TOP);
    for (let i = 0; i < top.length; i++) list.appendChild(chip(top[i], i + 1));
    const me = entries.findIndex((e) => e.me);
    if (me >= TOP) {
      list.appendChild(h('span', { class: 'ls-gap', text: '…' }));
      list.appendChild(chip(entries[me], me + 1));
    }
  }

  const unsubscribe = leaderboard.subscribe(render);
  const offCaption = watchCaption(leaderboard, caption);

  return {
    el,
    destroy() {
      offCaption();
      unsubscribe();
    },
  };
}
