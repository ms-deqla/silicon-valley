/**
 * The result screen (DESIGN.md 0, 12 and 20): when the buzzer sells the company or the
 * cash runs out, a full-column page with the company value, your share, the score, the
 * practice note when nothing was posted, two lines on what drove the number (the valuation
 * in force: floor or forecast; the why line), the takeaways of the post-mortem, the
 * timeline of your stake with markers (labelled on tap), the final leaderboard table (best
 * of the day), "Copy result" and Play again. The controller posts the final standing before
 * any listener runs, so the table already carries this run when the screen draws.
 */
import { CONFIG, takeaways, timeline, whyLine } from '../sim';
import type { GameState, MarkerKind, Result, TimelineMarker, TimelinePoint } from '../sim';
import type { ShellController } from './controller';
import { money, months, percent, plural } from './format';
import { leaderTable, longCaption, unposted, watchCaption } from './leaderstrip';
import { append, h, svg } from './panels/dom';
import { styleOnce } from './playbook';
import { GAME_TITLE } from './start';

export interface ResultScreen {
  /** Draw the screen when the run has ended; remove it when a new run starts. */
  update(state: GameState): void;
  destroy(): void;
}

export interface ResultHooks {
  /** A new round on the same world with the same name. */
  onPlayAgain(): void;
  /** the tournament code of this world ('' for today's), for the share link */
  code?: string;
}

const D = CONFIG.time.daysPerMonth;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------- the words

/** The link "Beat me" points at: this page, with the tournament code when the world has one. */
export function shareLink(code: string, href: string): string {
  try {
    const u = new URL(href);
    const base = `${u.origin}${u.pathname}`;
    return code ? `${base}?code=${encodeURIComponent(code)}` : base;
  } catch {
    return href;
  }
}

/**
 * DESIGN.md 20, one line: "Silicon Valley, 4 Nov: $821k, 69% owned, 17 months. Beat me: <link>".
 * The number is the score (your stake: value × your share); out of cash reads $0 and says so.
 */
export function copyText(state: GameState, opts: { date: Date; link: string; practice?: boolean }): string {
  const result = state.result;
  const score = result ? result.score : Math.max(0, state.valuation.value) * state.founderShare;
  const share = result ? result.founderShare : state.founderShare;
  const when = `${opts.date.getDate()} ${MONTH_NAMES[opts.date.getMonth()]}`;
  const tail = result?.kind === 'gameOver' ? ' (out of cash)' : opts.practice ? ' (practice)' : '';
  return `${GAME_TITLE}, ${when}: ${money(score)}, ${percent(share)} owned, ${months(state.history.length)}${tail}. Beat me: ${opts.link}`;
}

function stat(label: string, value: string, cls = ''): HTMLElement {
  return h('div', { class: `stat ${cls}`.trim() }, h('span', { class: 'stat-label', text: label }), h('b', { class: 'stat-value', text: value }));
}

/** Two lines on what drove the number: the valuation in force (DESIGN.md 10), then the why line (DESIGN.md 13). */
function explain(state: GameState, result: Result): [string, string] {
  const v = state.valuation;
  const first = result.kind === 'gameOver'
    ? `${result.reason} Running out of cash scores 0.`
    : v.floor >= v.operating
      ? `The value is the floor: cash, ${percent(CONFIG.valuation.arRecovery)} of receivables, ${percent(CONFIG.valuation.assetRecovery)} of assets at book and a team worth ${money(v.acquihire)}. The cash-flow forecast (${money(v.dcf)}) came to less.`
      : `The value is the cash-flow forecast plus net cash: ${money(v.runRate)}/mo of operating cash flow, growing ${percent(v.growth, 1)}/mo, at the ${percent(v.r, 1)} a year investors wanted.`;
  // At a month end the live book is empty, so the month just closed speaks for the bars.
  const atClose = state.day % CONFIG.time.daysPerMonth === 0 && state.history.length > 0;
  const whyState: GameState = atClose ? { ...state, book: state.history[state.history.length - 1] } : state;
  return [first, whyLine(whyState)];
}

// ---------------------------------------------------------------- the timeline

const TL_W = 388;
const TL_H = 132;
const TL_L = 44;
const TL_R = 12;
const TL_T = 14;
const TL_B = 22;
/** markers on the same month stack upward by this much */
const TL_STACK = 15;

const GLYPH: Record<MarkerKind, string> = { hire: 'H', fire: 'F', round: '$', event: '!', server: 'S', demo: 'D', upstairs: 'U' };
const MARKER_WORD: Record<MarkerKind, string> = { hire: 'hire', fire: 'fired', round: 'investor', event: 'event', server: 'server', demo: 'demo room', upstairs: 'second floor' };

const RESULT_CSS = `
.result-practice { font-size: 12.5px; font-weight: 700; color: var(--warn, #d98a1f); padding: 8px 10px; border-radius: 10px; background: rgba(217, 138, 31, 0.12); }
.takeaways { display: flex; flex-direction: column; gap: 8px; }
.takeaway { padding: 8px 10px; border-radius: 12px; background: rgba(255, 255, 255, 0.8); box-shadow: var(--shadow-soft, 0 4px 14px rgba(20, 22, 30, 0.08)); }
.takeaway b { display: block; font-size: 13.5px; }
.takeaway span { font-size: 12.5px; color: var(--ink-2, #5d616c); }
.tl { display: flex; flex-direction: column; gap: 4px; }
.tl svg { width: 100%; height: auto; display: block; border-radius: 12px; background: rgba(255, 255, 255, 0.8); box-shadow: var(--shadow-soft, 0 4px 14px rgba(20, 22, 30, 0.08)); }
.tl-line { fill: none; stroke: var(--product, #5b8def); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.tl-area { fill: rgba(91, 141, 239, 0.14); }
.tl-axis { stroke: rgba(34, 36, 43, 0.18); stroke-width: 1; }
.tl-tick { font-size: 9px; fill: var(--ink-3, #9094a0); font-weight: 700; }
.tl-y { font-size: 9px; fill: var(--ink-2, #5d616c); font-weight: 800; }
.tl-marker { cursor: pointer; }
.tl-marker circle { stroke: #fff; stroke-width: 1.5; }
.tl-marker text { font-size: 8.5px; font-weight: 900; fill: #fff; text-anchor: middle; pointer-events: none; }
.tl-marker.hire circle { fill: var(--product, #5b8def); }
.tl-marker.fire circle { fill: var(--bad, #d9534f); }
.tl-marker.round circle { fill: var(--good, #2f9e5b); }
.tl-marker.event circle { fill: var(--warn, #d98a1f); }
.tl-marker.server circle { fill: var(--ink-2, #5d616c); }
.tl-marker.demo circle { fill: var(--marketing, #a77bef); }
.tl-marker.upstairs circle { fill: #b08968; }
.tl-marker.active circle { stroke: var(--ink, #22242b); stroke-width: 2; }
.tl-label { min-height: 16px; }
.copy-fallback { width: 100%; min-height: 64px; font: inherit; font-size: 12.5px; padding: 8px 10px; border-radius: 10px; border: 1.5px solid var(--line, rgba(34, 36, 43, 0.08)); resize: none; user-select: text; -webkit-user-select: text; }
.result-actions .btn.copy { width: 100%; min-height: 46px; }
`;

/** A point on the drawn line: x in months from the start of the run, the stake there. */
interface Plot {
  x: number;
  stake: number;
}

/**
 * Where a closed month's point sits: TimelinePoint.month is the book's 0-based index
 * (MonthBook.month), and the value it carries is the one at that month's close, so month 0
 * is drawn at x = 1, the end of the first month, on the same axis the markers' day ÷ 30 uses.
 */
function plotOf(p: TimelinePoint): Plot {
  return { x: p.month + 1, stake: p.stake };
}

/** The stake at a (fractional) month, read off the plotted points by linear interpolation. */
function stakeAt(plots: Plot[], x: number): number {
  const first = plots[0];
  const last = plots[plots.length - 1];
  if (x <= first.x) return first.stake;
  if (x >= last.x) return last.stake;
  for (let i = 1; i < plots.length; i++) {
    const a = plots[i - 1];
    const b = plots[i];
    if (x <= b.x) {
      const t = b.x === a.x ? 1 : (x - a.x) / (b.x - a.x);
      return a.stake + (b.stake - a.stake) * t;
    }
  }
  return last.stake;
}

/**
 * DESIGN.md 20: one point per closed month (value, share, stake), the stake drawn as a line
 * with an area, and the markers (hires, rounds, events, servers, the demo room, the second
 * floor) on the line at their day, labelled on tap.
 */
function timelineView(state: GameState): HTMLElement {
  const data = timeline(state);
  const points = [...data.points].sort((a, b) => a.month - b.month).map(plotOf);
  const markers: TimelineMarker[] = [...data.markers].sort((a, b) => a.day - b.day);
  const label = h('p', { class: 'caption tl-label', text: markers.length ? 'Tap a marker for what happened.' : '' });
  if (points.length === 0) return h('div', { class: 'tl' }, h('p', { class: 'caption', text: 'No month closed, so there is no timeline.' }));

  const lastMonth = Math.max(1, ...points.map((p) => p.x), ...markers.map((m) => m.day / D));
  const maxStake = Math.max(1, ...points.map((p) => p.stake));
  const X = (month: number): number => TL_L + (month / lastMonth) * (TL_W - TL_L - TL_R);
  const Y = (stake: number): number => TL_T + (1 - Math.max(0, stake) / maxStake) * (TL_H - TL_T - TL_B);
  const f = (n: number): string => n.toFixed(1);

  // the line starts at month 0 (the day the clock started) with the first closed month's stake
  const drawn: Plot[] = points[0].x > 0 ? [{ x: 0, stake: points[0].stake }, ...points] : points;
  let line = '';
  for (let i = 0; i < drawn.length; i++) line += `${i === 0 ? 'M' : 'L'}${f(X(drawn[i].x))} ${f(Y(drawn[i].stake))}`;
  const area = `${line}L${f(X(drawn[drawn.length - 1].x))} ${f(Y(0))}L${f(X(drawn[0].x))} ${f(Y(0))}Z`;

  const el = svg('svg', { viewBox: `0 0 ${TL_W} ${TL_H}`, role: 'img', 'aria-label': 'Your stake over the months' },
    svg('path', { class: 'tl-area', d: area }),
    svg('path', { class: 'tl-line', d: line }),
    svg('line', { class: 'tl-axis', x1: TL_L, y1: f(Y(0)), x2: TL_W - TL_R, y2: f(Y(0)) }),
    svg('text', { class: 'tl-y', x: 2, y: TL_T + 4 }, money(maxStake)),
    svg('text', { class: 'tl-y', x: 2, y: f(Y(0)) }, '$0'));
  const step = lastMonth > 18 ? 6 : lastMonth > 8 ? 3 : 1;
  for (let m = 0; m <= lastMonth + 0.001; m += step) {
    el.appendChild(svg('text', { class: 'tl-tick', x: f(X(m)), y: TL_H - 7, 'text-anchor': m === 0 ? 'start' : 'middle' }, m === 0 ? 'month 0' : String(m)));
  }

  let active: SVGElement | null = null;
  const stacks = new Map<number, number>();
  for (const m of markers) {
    const month = m.day / D;
    const slot = Math.round(X(month) / 10);
    const n = stacks.get(slot) ?? 0;
    stacks.set(slot, n + 1);
    const cx = X(month);
    const cy = Math.max(10, Y(stakeAt(points, month)) - n * TL_STACK);
    const text = `Month ${Math.max(1, Math.ceil(m.day / D))} · ${m.label}`;
    const g = svg('g', { class: `tl-marker ${m.kind}`, tabindex: 0, role: 'button', 'aria-label': `${MARKER_WORD[m.kind]}: ${text}` },
      svg('title', {}, text),
      svg('circle', { cx: f(cx), cy: f(cy), r: 7 }),
      svg('text', { x: f(cx), y: f(cy + 3) }, GLYPH[m.kind]));
    const pick = (): void => {
      active?.classList.remove('active');
      active = g;
      g.classList.add('active');
      label.textContent = text;
    };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        pick();
      }
    });
    el.appendChild(g);
  }
  return h('div', { class: 'tl' }, el, label);
}

// ---------------------------------------------------------------- the screen

export function createResult(controller: ShellController, layer: HTMLElement, hooks: ResultHooks): ResultScreen {
  styleOnce('sv-result-style', RESULT_CSS);
  let shown: Result | null = null;
  let unsubscribe: (() => void) | null = null;
  const screen = h('div', { class: 'result-screen', attrs: { role: 'dialog', 'aria-modal': 'true' } });

  function render(state: GameState, result: Result): void {
    unsubscribe?.();
    const sold = result.kind === 'sold';
    const practice = controller.practice;
    screen.className = `result-screen ${sold ? 'sold' : 'dead'}`;
    const [line1, line2] = explain(state, result);
    const value = sold ? result.offer : Math.max(0, state.valuation.value);

    const tableWrap = h('div', { class: 'lb-wrap' });
    const caption = h('p', { class: 'caption' });
    caption.hidden = true;

    // DESIGN.md 20: the three takeaways with the biggest impact
    const notes = takeaways(state, { cardWaitMs: controller.cardWaitMs, practice });
    const takeawayList = h('div', { class: 'takeaways' },
      ...notes.map((t) => h('div', { class: 'takeaway' }, h('b', { text: t.title }), h('span', { text: t.detail }))));

    // DESIGN.md 20: "Copy result", the clipboard inside the click handler, a selectable fallback
    const fallback = h('textarea', { class: 'copy-fallback', attrs: { readonly: '', 'aria-label': 'Your result, ready to copy' } });
    fallback.hidden = true;
    const copyBtn = h('button', { class: 'btn copy', type: 'button', text: 'Copy result' });
    const showFallback = (text: string): void => {
      fallback.value = text;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
      copyBtn.textContent = 'Select and copy';
    };
    copyBtn.addEventListener('click', () => {
      const text = copyText(state, { date: new Date(), link: shareLink(hooks.code ?? '', location.href), practice });
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(text).then(
          () => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => {
              copyBtn.textContent = 'Copy result';
            }, 1_800);
          },
          () => showFallback(text),
        );
      } else {
        showFallback(text);
      }
    });

    screen.replaceChildren();
    append(screen, [
      h('div', { class: 'result-kind', text: sold ? 'The buzzer' : 'Game over' }),
      h('h1', { class: 'result-headline', text: sold ? "Time's up" : 'Out of cash' }),
      h('div', { class: 'result-stats' },
        stat('Company value', money(value)),
        stat('Your share', percent(result.founderShare, 1)),
        stat('Score · value × your share', money(result.score), 'big')),
      practice ? h('p', { class: 'result-practice', text: 'Practice run: nothing was posted to the board.' }) : null,
      h('div', { class: 'result-why' }, h('p', { text: line1 }), h('p', { text: line2 })),
      notes.length > 0 ? h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'What this run says' }), takeawayList) : null,
      h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Your stake, month by month' }), timelineView(state)),
      h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: hooks.code ? `The world of “${hooks.code}”` : "Today's world" }), tableWrap, caption),
      h('p', { class: 'result-meta', text: `${months(state.history.length)} played · ${plural(state.customers.length, 'customer')} · ${plural(state.people.length, 'person', 'people')} · world ${state.seed}` }),
      h('div', { class: 'result-actions' },
        copyBtn,
        fallback,
        h('button', { class: 'btn primary again', type: 'button', text: 'Play again', onClick: () => hooks.onPlayAgain() }),
        h('p', { class: 'caption', text: practice ? 'Same world, same name. Practice again, or start the clock for a scored run from the start screen.' : 'Same world, same name. A new run replaces this score on the board.' })),
    ]);

    const lb = controller.leaderboard;
    const offTable = lb.subscribe((entries) => {
      tableWrap.replaceChildren(leaderTable(entries, { unposted: unposted(lb) }));
    });
    const offCaption = watchCaption(lb, caption, longCaption);
    unsubscribe = () => {
      offTable();
      offCaption();
    };
  }

  function remove(): void {
    unsubscribe?.();
    unsubscribe = null;
    screen.remove();
  }

  function update(state: GameState): void {
    if (state.status === 'playing' || !state.result) {
      if (shown) {
        shown = null;
        remove();
      }
      return;
    }
    if (shown !== state.result) {
      shown = state.result;
      render(state, state.result);
    }
    if (!screen.isConnected) layer.appendChild(screen);
  }

  return {
    update,
    destroy() {
      shown = null;
      remove();
    },
  };
}
