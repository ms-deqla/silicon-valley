/**
 * The live leaderboard strip between the hint line and the office (DESIGN.md 0): the
 * top four players on today's world plus you when you are not among them, in the live
 * order (finished runs by score, then runs still going by company value, then runs
 * left mid-round), each chip in the player's colour (DESIGN.md 20), and under your chip
 * the pace line: how far you are behind the leader, or "You lead". Subscribes once and
 * draws only when the entries change. Also home of the words every leaderboard view uses
 * for an entry (its status, the number it is ranked by, the mark that says what that
 * number is), of the best-of-the-day table the start and result screens show, and of the
 * store caption ("Local only", "Your run is not on the shared board", "Leaderboard may be
 * out of date").
 */
import { money } from './format';
import { COLOR_HEX, bestOf, sortEntriesByBest, standing } from './leaderboard';
import type { LeaderEntry, Leaderboard } from './leaderboard';
import { h } from './panels/dom';
import { styleOnce } from './playbook';

export interface LeaderStrip {
  el: HTMLElement;
  destroy(): void;
}

/** Players shown before "… you" is appended. */
const TOP = 4;

/** "Sold" / "Out of cash" / "Playing · month 7" / "Abandoned · month 7" (a run left mid-round). */
export function entryStatus(e: LeaderEntry): string {
  if (e.status === 'sold') return 'Sold';
  if (e.status === 'dead') return 'Out of cash';
  return `${e.abandoned ? 'Abandoned' : 'Playing'} · month ${e.month}`;
}

/** The number every run is ranked by live (DESIGN.md 0): the score once finished, what the buzzer would pay now while playing. */
export function entryAmount(e: LeaderEntry): string {
  return money(standing(e));
}

/**
 * What a shown number is: what the buzzer would pay for a run still going ('now'), a
 * finished run's score ('done' for sold, 'out' for out of cash), the day's best from an
 * earlier run ('best'), the frozen number of a run left mid-round ('left'), or the local
 * player's run that the shared board never received ('local').
 */
export type Mark = 'now' | 'done' | 'out' | 'best' | 'left' | 'local';

/** The mark of a run's own score: what the buzzer would pay now while playing, the final score once finished. */
export function markOf(e: LeaderEntry): Mark {
  if (e.abandoned) return 'left';
  return e.status === 'playing' ? 'now' : e.status === 'sold' ? 'done' : 'out';
}

/**
 * DESIGN.md 0: a viewer the store refuses to write for (view-only) still sees everyone
 * else live, but their own run never reaches the board: their line is marked, and the
 * caption says so, instead of reading as a posted standing.
 */
export function unposted(lb: Leaderboard): boolean {
  return lb.shared && !lb.canWrite;
}

/**
 * DESIGN.md 20, the pace line under your chip: "$X behind <leader>" or "You lead"; empty
 * when you are not on the list. The leader is the first entry of the live order, which
 * puts runs left mid-round last, so a frozen run never leads.
 */
export function paceLine(entries: readonly LeaderEntry[]): string {
  const me = entries.find((e) => e.me);
  const leader = entries[0];
  if (!me || !leader) return '';
  if (leader.me) return 'You lead';
  const gap = standing(leader) - standing(me);
  if (gap < 0.5) return `Level with ${leader.name}`;
  return `${money(gap)} behind ${leader.name}`;
}

const MARK_TEXT: Record<Mark, string> = { now: 'now', done: '✓', out: 'out', best: 'best', left: 'left', local: 'not posted' };
const MARK_TITLE: Record<Mark, string> = {
  now: 'What the buzzer would pay now: runs still going are ranked by it',
  done: 'Finished: the buzzer sold the company',
  out: 'Out of cash: scores 0',
  best: "This player's best score today",
  left: 'Left mid-round: this run will not finish',
  local: 'Not on the shared board: this page may read it but not post to it',
};

function markEl(m: Mark, cls: string): HTMLElement {
  return h('span', { class: `${cls} ${m}`, text: MARK_TEXT[m], title: MARK_TITLE[m] });
}

/** DESIGN.md 20: the player's colour as a dot before the name, in the strip and the tables. */
function colorDot(e: LeaderEntry, cls: string): HTMLElement {
  return h('i', { class: cls, style: `background:${COLOR_HEX[e.color]}`, title: e.color, attrs: { 'aria-hidden': 'true' } });
}

const STRIP_CSS = `
.ls-dot, .lb-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1px rgba(20, 22, 30, 0.18); vertical-align: -1px; margin-right: 4px; }
.ls-chip.me { flex-wrap: wrap; max-width: 220px; }
.ls-pace { flex-basis: 100%; font-size: 9.5px; font-weight: 700; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.1; }
`;

/** The caption when the store refused this viewer's writes: their run stays on this page. */
export const UNPOSTED_CAPTION = 'Your run is not on the shared board';

/**
 * The caption a leaderboard view shows once `ready` resolved: where the list comes from
 * when it is not the shared store, that this viewer's run is not on it, or that the
 * store has not confirmed it (db contract: no snapshot within 10 s); empty when the
 * shared list is fresh.
 */
export function storeCaption(lb: Leaderboard): string {
  if (!lb.shared) return lb.canWrite ? 'Local only' : 'Leaderboard unavailable';
  if (unposted(lb)) return UNPOSTED_CAPTION;
  return lb.stale ? 'Leaderboard may be out of date' : '';
}

/** The start and result screens' wording of the caption. */
export function longCaption(text: string): string {
  if (text === 'Local only') return "Local only: this browser's player.";
  if (text === UNPOSTED_CAPTION) return `${UNPOSTED_CAPTION}: this page may read it but not post to it. The other players are live.`;
  return text;
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

/** The mark of the number a table shows: the day's best when it comes from an earlier run, else the run's own. */
function tableMark(e: LeaderEntry, amount: number): Mark {
  if (e.abandoned) return amount > 0 ? 'best' : 'left';
  return amount > e.score ? 'best' : markOf(e);
}

/**
 * The best-of-the-day table (start screen preview, result screen): rank, colour and
 * name, the number each player is ranked by (a finished player's best score today; a run
 * still going by what the buzzer would pay now, or by its earlier best when that is
 * higher; a run left mid-round by its earlier best alone) with its mark,
 * status; the local player highlighted, and marked "not posted" when the shared board
 * never received their run (`opts.unposted`). Names come from other players, so they
 * are set as text, never markup.
 */
export function leaderTable(entries: LeaderEntry[], opts: { unposted?: boolean } = {}): HTMLElement {
  styleOnce('sv-strip-style', STRIP_CSS);
  if (entries.length === 0) return h('p', { class: 'lb-empty', text: "Nobody on today's world yet. Be the first." });
  const rows = sortEntriesByBest(entries).map((e, i) => {
    const amount = bestOf(e);
    const m: Mark = e.me && opts.unposted ? 'local' : tableMark(e, amount);
    return h('tr', { class: e.me ? 'me' : '' },
      h('td', { text: String(i + 1) }),
      h('td', { class: 'lb-name', title: e.name }, colorDot(e, 'lb-dot'), e.name),
      h('td', { class: `lb-score${m === 'now' || m === 'left' ? ' muted' : ''}` }, h('span', { text: money(amount) }), markEl(m, 'lb-mark')),
      h('td', { text: entryStatus(e) }));
  });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table lb' },
    h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Name' }), h('th', { text: 'Score' }), h('th', { text: 'Status' }))),
    h('tbody', {}, ...rows)));
}

export function createLeaderStrip(leaderboard: Leaderboard): LeaderStrip {
  styleOnce('sv-strip-style', STRIP_CSS);
  const list = h('div', { class: 'ls-list' });
  const caption = h('span', { class: 'ls-caption' });
  caption.hidden = true;
  const el = h('div', { class: 'leaderstrip', attrs: { 'aria-label': 'Live leaderboard', 'data-tour': 'strip' } },
    h('span', { class: 'ls-live', text: 'LIVE' }), list, caption);

  /**
   * Rank, colour, name, the number the run is ranked by with its mark (or "not posted"), the
   * day's best when an earlier run did better; your chip outlined in your colour with the
   * pace line under it (DESIGN.md 20).
   */
  function chip(e: LeaderEntry, rank: number, local: boolean, pace: string): HTMLElement {
    const playing = e.status === 'playing';
    const m: Mark = local ? 'local' : markOf(e);
    const better = e.best > e.score;
    return h('span', {
      class: `ls-chip${e.me ? ' me' : ''}${playing && !e.abandoned ? '' : ' done'}`,
      style: e.me ? `box-shadow:0 0 0 2px ${COLOR_HEX[e.color]}` : undefined,
      title: `${e.name} · ${entryStatus(e)} · ${playing ? 'now' : 'score'} ${entryAmount(e)}${better ? ` · best today ${money(e.best)}` : ''}${local ? ` · ${MARK_TITLE.local}` : ''}`,
    },
    h('b', { class: 'ls-rank', text: String(rank) }),
    colorDot(e, 'ls-dot'),
    h('span', { class: 'ls-name', text: e.name }),
    h('span', { class: 'ls-val', text: entryAmount(e) }),
    markEl(m, 'ls-mark'),
    better ? h('small', { class: 'ls-best', text: `best ${money(e.best)}` }) : null,
    e.me && pace ? h('small', { class: 'ls-pace', text: pace }) : null);
  }

  function render(entries: LeaderEntry[]): void {
    list.replaceChildren();
    if (entries.length === 0) {
      list.appendChild(h('span', { class: 'ls-empty', text: "Nobody on today's world yet" }));
      return;
    }
    const local = unposted(leaderboard);
    const pace = paceLine(entries);
    const top = entries.slice(0, TOP);
    for (let i = 0; i < top.length; i++) list.appendChild(chip(top[i], i + 1, local && top[i].me, pace));
    const me = entries.findIndex((e) => e.me);
    if (me >= TOP) {
      list.appendChild(h('span', { class: 'ls-gap', text: '…' }));
      list.appendChild(chip(entries[me], me + 1, local, pace));
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
