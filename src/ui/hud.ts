/**
 * The HUD: four glassy pills (Cash, Profit MTD, Cash flow MTD, Company value with a
 * sparkline), the calendar badge beside the round countdown, then the why line and the
 * hint line. DESIGN.md sections 0, 9, 13. Values are patched in place on every state
 * change; the countdown is patched every frame from the wall clock.
 */
import { CONFIG, hintLine, ledger, selectors, whyLine } from '../sim';
import type { GameState } from '../sim';
import { clock, money, percent } from './format';
import { h, svg } from './panels/dom';

export interface Hud {
  el: HTMLElement;
  /** Patch values from state; cheap enough for every sim day. */
  update(state: GameState): void;
  /** Every frame: writes the DOM only when the shown second or its colour changes. */
  tickClock(remainingMs: number): void;
}

export interface HudHooks {
  /** Cash, Profit, Cash flow pills: the Books on the remembered tab. */
  onBooks(): void;
  /** The Company value pill: the Books where "Investors want r%" lists each premium (DESIGN.md 10). */
  onValue(): void;
}

/** Points of value history drawn in the sparkline (12 months of change). */
const SPARK_POINTS = CONFIG.valuation.historyMonths + 1;
const SPARK_W = 40;
const SPARK_H = 16;
/** DESIGN.md 0: the countdown turns amber under two minutes and red under thirty seconds. */
const WARN_MS = 120_000;
const DANGER_MS = 30_000;

function sparkPaths(values: number[]): { line: string; area: string; up: boolean } {
  const pts = values.slice(-SPARK_POINTS);
  if (pts.length < 2) pts.unshift(pts[0] ?? 0);
  let lo = Math.min(...pts);
  let hi = Math.max(...pts);
  if (hi - lo < 1) {
    hi += 1;
    lo -= 1;
  }
  const xs = pts.map((_, i) => (i / (pts.length - 1)) * (SPARK_W - 2) + 1);
  const ys = pts.map((v) => SPARK_H - 2 - ((v - lo) / (hi - lo)) * (SPARK_H - 4));
  let line = '';
  for (let i = 0; i < pts.length; i++) line += `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
  const area = `${line}L${xs[xs.length - 1].toFixed(1)} ${SPARK_H}L${xs[0].toFixed(1)} ${SPARK_H}Z`;
  // a move under 1% (depreciation nibbling at the floor) is flat, not a fall
  return { line, area, up: pts[pts.length - 1] >= pts[0] * 0.99 };
}

export function createHud(hooks: HudHooks): Hud {
  function pill(label: string, onClick: () => void, title: string, extra?: Node): { el: HTMLElement; value: HTMLElement } {
    const value = h('span', { class: 'pill-value', text: '—' });
    const el = h('button', { class: 'pill', type: 'button', title, onClick },
      h('span', { class: 'pill-label', text: label }),
      h('span', { class: 'pill-row' }, value, extra ?? null));
    return { el, value };
  }

  const sparkLine = svg('path', { class: 'spark-line', d: '', fill: 'none', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const sparkArea = svg('path', { class: 'spark-area', d: '' });
  const spark = svg('svg', { class: 'spark', viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, 'aria-hidden': 'true' }, sparkArea, sparkLine);

  const cash = pill('Cash', hooks.onBooks, 'Open the books');
  const profit = pill('Profit · MTD', hooks.onBooks, 'Profit, month to date. Open the books');
  const fcf = pill('Cash flow · MTD', hooks.onBooks, 'Free cash flow, month to date. Open the books');
  const value = pill('Company value', hooks.onValue, 'What investors want', spark);

  const calLabel = h('b', { class: 'cal-label', text: '' });
  const calDay = h('span', { class: 'cal-day', text: '' });
  const calendar = h('div', { class: 'cal' }, calLabel, calDay);

  const countdown = h('div', {
    class: 'countdown',
    text: '—:——',
    title: 'Time left in the round. When it hits zero the buzzer sells the company.',
    attrs: { role: 'timer', 'aria-label': 'Time left in the round' },
  });

  const why = h('div', { class: 'why' });
  const hint = h('div', { class: 'hint' });

  const el = h('div', { class: 'hud' },
    h('div', { class: 'pills' }, cash.el, profit.el, fcf.el, value.el),
    h('div', { class: 'hud-row' }, calendar, countdown),
    h('div', { class: 'lines' }, why, hint));

  function tone(target: HTMLElement, n: number): void {
    target.classList.toggle('neg', n < -0.5);
    target.classList.toggle('pos', n > 0.5);
  }

  function update(state: GameState): void {
    cash.value.textContent = money(state.cash);
    cash.value.classList.toggle('neg', state.cash < 0);
    const p = ledger.profitOf(state.book);
    profit.value.textContent = money(p);
    tone(profit.value, p);
    const f = ledger.fcfOf(state.book);
    fcf.value.textContent = money(f);
    tone(fcf.value, f);
    value.value.textContent = money(state.valuation.value);
    value.el.title = state.valuation.floor >= state.valuation.operating
      ? 'Floor value: cash, receivables, assets and the team. The cash-flow forecast is lower. Tap for the breakdown.'
      : `Investors want ${percent(state.valuation.r, 1)} a year. Tap for the breakdown.`;
    const sp = sparkPaths(state.valueHistory);
    sparkLine.setAttribute('d', sp.line);
    sparkArea.setAttribute('d', sp.area);
    spark.classList.toggle('down', !sp.up);

    const cal = selectors.calendar(state.day);
    calLabel.textContent = cal.label;
    calDay.textContent = `Day ${cal.dayOfMonth} · month ${cal.month + 1}`;
    calendar.title = `Game day ${state.day}`;

    // DESIGN.md 13: whole sentences; the title keeps the full text reachable if the two-row clamp ever cuts one
    const w = whyLine(state);
    why.textContent = w;
    why.title = w;
    why.hidden = !w;
    const hi = hintLine(state);
    hint.textContent = hi;
    hint.title = hi;
    hint.hidden = !hi;
  }

  let shownClock = '';
  let shownTone = '';
  function tickClock(remainingMs: number): void {
    const text = clock(remainingMs);
    if (text !== shownClock) {
      shownClock = text;
      countdown.textContent = text;
    }
    const t = remainingMs < DANGER_MS ? 'danger' : remainingMs < WARN_MS ? 'warn' : '';
    if (t !== shownTone) {
      shownTone = t;
      countdown.classList.toggle('warn', t === 'warn');
      countdown.classList.toggle('danger', t === 'danger');
    }
  }

  return { el, update, tickClock };
}
