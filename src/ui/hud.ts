/**
 * The HUD: four glassy pills (Cash, Profit MTD, Cash flow MTD, Company value with a
 * sparkline), the calendar badge, speed buttons, the gear, then the why line and the
 * hint line. DESIGN.md sections 4, 9, 13. Patched in place on every state change.
 */
import { hintLine, ledger, selectors, whyLine } from '../sim';
import type { GameState } from '../sim';
import type { Speed } from './api';
import type { ShellController } from './controller';
import { money, percent } from './format';
import { h, svg } from './panels/dom';

export interface Hud {
  el: HTMLElement;
  /** Patch values from state; cheap enough for every sim day. */
  update(state: GameState): void;
  /** Re-highlight the speed buttons (speed can change without a state change). */
  refreshSpeed(): void;
}

export interface HudHooks {
  /** Cash, Profit, Cash flow pills: the Books on the remembered tab. */
  onBooks(): void;
  /** The Company value pill: the Books where "Investors want r%" lists each premium (DESIGN.md 10). */
  onValue(): void;
  onGear(): void;
}

/** Points of value history drawn in the sparkline (12 months of change). */
const SPARK_POINTS = 13;
const SPARK_W = 64;
const SPARK_H = 22;

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
  return { line, area, up: pts[pts.length - 1] >= pts[0] };
}

export function createHud(controller: ShellController, hooks: HudHooks): Hud {
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
  const profit = pill('Profit · month to date', hooks.onBooks, 'Open the books');
  const fcf = pill('Cash flow · month to date', hooks.onBooks, 'Open the books');
  const value = pill('Company value', hooks.onValue, 'What investors want', spark);

  const calLabel = h('b', { class: 'cal-label', text: '' });
  const calDay = h('span', { class: 'cal-day', text: '' });
  const calendar = h('div', { class: 'cal' }, calLabel, calDay);

  const speedButtons = new Map<Speed, HTMLButtonElement>();
  const speedGroup = h('div', { class: 'speeds', attrs: { role: 'group', 'aria-label': 'Speed' } });
  const speeds: { s: Speed; label: string; title: string }[] = [
    { s: 0, label: '⏸', title: 'Pause (space)' },
    { s: 1, label: '1×', title: 'Normal speed (1)' },
    { s: 3, label: '3×', title: 'Fast (3)' },
    { s: 10, label: '10×', title: 'Debug speed' },
  ];
  for (const sp of speeds) {
    const b = h('button', { class: 'speed-btn', type: 'button', text: sp.label, title: sp.title, onClick: () => {
      controller.speed = sp.s;
      refreshSpeed();
    } });
    speedButtons.set(sp.s, b);
    speedGroup.appendChild(b);
  }

  const gear = h('button', { class: 'icon-btn gear', type: 'button', text: '⚙', title: 'Settings', attrs: { 'aria-label': 'Settings' }, onClick: hooks.onGear });

  const why = h('div', { class: 'why' });
  const hint = h('div', { class: 'hint' });

  const el = h('div', { class: 'hud' },
    h('div', { class: 'pills' }, cash.el, profit.el, fcf.el, value.el),
    h('div', { class: 'hud-row' }, calendar, speedGroup, gear),
    h('div', { class: 'lines' }, why, hint));

  function tone(target: HTMLElement, n: number): void {
    target.classList.toggle('neg', n < -0.5);
    target.classList.toggle('pos', n > 0.5);
  }

  function refreshSpeed(): void {
    const cur = controller.speed;
    for (const [s, b] of speedButtons) {
      b.classList.toggle('active', s === cur);
      // the 10× button is debug-only: shown while in use
      if (s === 10) b.hidden = cur !== 10;
    }
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
    value.el.title = `Investors want ${percent(state.valuation.r, 1)} a year. Tap for the breakdown.`;
    const sp = sparkPaths(state.valueHistory);
    sparkLine.setAttribute('d', sp.line);
    sparkArea.setAttribute('d', sp.area);
    spark.classList.toggle('down', !sp.up);

    const cal = selectors.calendar(state.day);
    calLabel.textContent = cal.label;
    calDay.textContent = `Day ${cal.dayOfMonth}`;
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
    refreshSpeed();
  }

  refreshSpeed();
  return { el, update, refreshSpeed };
}
