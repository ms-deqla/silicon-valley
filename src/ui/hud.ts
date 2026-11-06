/**
 * The HUD (DESIGN.md 0, 17): four glass pills — Cash, Profit (MTD), Cash flow (MTD) and
 * Your stake (value × your share: the score the buzzer would take now, with "69% of
 * $1.2M" under it and the sparkline of the stake) — the cap-table bar, the calendar badge
 * beside the round countdown with the help and speaker buttons, then the why line and
 * the coach line (DESIGN.md 18: the single best next action, with a tap that does it).
 * Values are patched in place on every state change; the countdown every frame from the
 * wall clock. Nothing here mutates the sim except through hooks.dispatch.
 */
import { CONFIG, advise, ledger, selectors, whyLine } from '../sim';
import type { Action, Advice, GameState } from '../sim';
import type { Audio } from './audio';
import { capTable, clock, money, percent, stakeHistory } from './format';
import { icon } from './icons';
import type { IconName } from './icons';
import { h, svg } from './panels/dom';

export interface Hud {
  el: HTMLElement;
  /** Patch values from state; cheap enough for every sim day. */
  update(state: GameState): void;
  /** Every frame: writes the DOM only when the shown second or its colour changes. */
  tickClock(remainingMs: number): void;
  /** DESIGN.md 0, Pause: the button shows play and the countdown dims while paused. */
  setPaused(paused: boolean): void;
}

export interface HudHooks {
  /** Cash, Profit, Cash flow pills: the Books on the remembered tab. */
  onBooks(): void;
  /** The stake pill: the Books where the cap table and "Investors want r%" live (DESIGN.md 0, 10). */
  onValue(): void;
  /** The "?" button opens the Playbook (DESIGN.md 18). Without a hook the button is not drawn. */
  onHelp?: () => void;
  /** The pause button (DESIGN.md 0): pauses or resumes the round. Without a hook the button is not drawn. */
  onPause?: () => void;
  /** The coach line's tap does the advised action through here (DESIGN.md 0: advice only, never automatic). */
  dispatch?: (action: Action) => void;
  /** The speaker button (DESIGN.md 19): bound to this; not drawn without it, hidden while !audio.available. */
  audio?: Audio;
  /** Your colour (DESIGN.md 0): your slice of the cap-table bar. The blue accent by default. */
  playerColor?: string;
}

/** Points of stake history drawn in the sparkline (12 months of change). */
const SPARK_POINTS = CONFIG.valuation.historyMonths + 1;
const SPARK_W = 40;
const SPARK_H = 16;
/** DESIGN.md 0: the countdown turns amber under two minutes and red under thirty seconds. */
const WARN_MS = 120_000;
const DANGER_MS = 30_000;
/** A tapped cap-table segment shows its label this long (hover keeps it up on a pointer). */
const CAP_TAG_MS = 2_500;
/** DESIGN.md 17: your slice of the cap-table bar falls back to the blue accent. */
const DEFAULT_PLAYER_COLOR = '#3B82F6';

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

interface Pill {
  el: HTMLElement;
  value: HTMLElement;
  body: HTMLElement;
  /** swap the icon (the profit arrow points the way profit went) */
  setIcon(name: IconName): void;
}

/** DESIGN.md 17: a glass pill, icon left in its accent colour, label small, number large. */
function pill(cls: string, iconName: IconName, label: string, onClick: () => void, title: string, extra?: Node): Pill {
  const value = h('span', { class: 'pill-value', text: '—' });
  const iconBox = h('span', { class: 'pill-icon' }, icon(iconName));
  const body = h('span', { class: 'pill-body' },
    h('span', { class: 'pill-head' }, iconBox, h('span', { class: 'pill-label', text: label })),
    h('span', { class: 'pill-row' }, value, extra ?? null));
  const el = h('button', { class: `pill ${cls}`, type: 'button', title, onClick }, body);
  let shownIcon = iconName;
  return {
    el,
    value,
    body,
    setIcon(name) {
      if (name === shownIcon) return;
      shownIcon = name;
      iconBox.replaceChildren(icon(name));
    },
  };
}

export function createHud(hooks: HudHooks): Hud {
  const sparkLine = svg('path', { class: 'spark-line', d: '', fill: 'none', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const sparkArea = svg('path', { class: 'spark-area', d: '' });
  const spark = svg('svg', { class: 'spark', viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, 'aria-hidden': 'true' }, sparkArea, sparkLine);

  const cash = pill('cash', 'cash', 'Cash', hooks.onBooks, 'Cash in the bank. Open the books');
  const profit = pill('profit', 'trendUp', 'Profit', hooks.onBooks, 'Profit, month to date. Open the books');
  const fcf = pill('fcf', 'bars', 'Cash flow', hooks.onBooks, 'Free cash flow, month to date. Open the books');
  const stake = pill('stake', 'pie', 'Your stake', hooks.onValue, 'What the buzzer would pay you now: company value × your share. Tap for the cap table and the valuation', spark);
  const stakeSub = h('span', { class: 'pill-sub', text: '' });
  stake.body.appendChild(stakeSub);

  // DESIGN.md 0, 17: the cap-table bar, your slice in your colour, each round a grey segment
  const capBar = h('div', { class: 'captable', attrs: { role: 'img', 'aria-label': 'Cap table' } });
  const playerColor = hooks.playerColor ?? DEFAULT_PLAYER_COLOR;
  let capSignature = '';
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  function closeCapTags(): void {
    for (const seg of capBar.children) seg.classList.remove('is-open');
  }
  function renderCapBar(state: GameState): void {
    const entries = capTable(state);
    const signature = `${state.founderShare.toFixed(5)}|${entries.map((e) => `${e.label}:${e.share.toFixed(5)}`).join(',')}`;
    if (signature === capSignature) return;
    capSignature = signature;
    capBar.replaceChildren();
    capBar.setAttribute('aria-label', `Cap table: ${entries.map((e) => `${e.label} ${percent(e.share)}`).join(', ')}`);
    for (const e of entries) {
      const seg = h('span', {
        class: `cap-seg ${e.kind}${e.round?.desperate ? ' desperate' : ''}`,
        style: `flex: ${Math.max(e.share, 0.004).toFixed(4)} 1 0px;${e.kind === 'you' ? ` background: ${playerColor};` : ''}`,
        title: `${e.label} · ${percent(e.share, 1)}${e.round ? ` · ${money(e.round.amount)} in` : ''}`,
      }, h('span', { class: 'cap-tag', text: `${e.kind === 'you' ? 'You' : e.initials} ${percent(e.share)}` }));
      seg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const open = seg.classList.contains('is-open');
        closeCapTags();
        if (capTimer !== null) clearTimeout(capTimer);
        if (open) return;
        seg.classList.add('is-open');
        capTimer = setTimeout(closeCapTags, CAP_TAG_MS);
      });
      capBar.appendChild(seg);
    }
  }

  // DESIGN.md 17: the calendar badge, a white card with a blue header strip
  const calHead = h('span', { class: 'cal-head', text: '' });
  const calMonth = h('b', { class: 'cal-month', text: '' });
  const calDay = h('span', { class: 'cal-day', text: '' });
  const calendar = h('div', { class: 'cal' }, calHead, h('span', { class: 'cal-body' }, calMonth, calDay));

  const countdown = h('div', {
    class: 'countdown',
    text: '—:——',
    title: 'Time left in the round. When it hits zero the buzzer sells the company.',
    attrs: { role: 'timer', 'aria-label': 'Time left in the round', 'data-tour': 'countdown' },
  });

  const help = hooks.onHelp
    ? h('button', { class: 'hud-btn help', type: 'button', title: 'How to play', attrs: { 'aria-label': 'How to play' }, onClick: () => hooks.onHelp?.() }, icon('question'))
    : null;

  // DESIGN.md 0, Pause: the pause button; the countdown freezes and dims while paused
  const pause = hooks.onPause
    ? h('button', { class: 'hud-btn pause', type: 'button', attrs: { 'aria-label': 'Pause', 'aria-pressed': 'false', 'data-tour': 'pause' }, onClick: () => hooks.onPause?.() })
    : null;
  function setPaused(paused: boolean): void {
    countdown.classList.toggle('paused', paused);
    countdown.title = paused
      ? 'Paused. Tap play to continue.'
      : 'Time left in the round. When it hits zero the buzzer sells the company.';
    if (!pause) return;
    pause.replaceChildren(icon(paused ? 'play' : 'pause'));
    pause.classList.toggle('on', paused);
    pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pause.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    pause.title = paused ? 'Resume the round (Space)' : 'Pause the round (Space)';
  }
  setPaused(false);

  // DESIGN.md 19: the speaker button, hidden when no AudioContext can be created
  const audio = hooks.audio;
  const speaker = audio
    ? h('button', { class: 'hud-btn speaker', type: 'button', attrs: { 'aria-label': 'Sound' } })
    : null;
  function syncSpeaker(): void {
    if (!audio || !speaker) return;
    speaker.hidden = !audio.available;
    speaker.replaceChildren(icon(audio.enabled ? 'speakerOn' : 'speakerOff'));
    speaker.classList.toggle('off', !audio.enabled);
    speaker.setAttribute('aria-pressed', audio.enabled ? 'true' : 'false');
    speaker.title = audio.enabled ? 'Sound on. Tap to mute' : 'Sound off. Tap for sound';
  }
  speaker?.addEventListener('click', () => {
    if (!audio) return;
    audio.setEnabled(!audio.enabled);
    syncSpeaker();
  });
  syncSpeaker();

  const why = h('div', { class: 'why' });

  // DESIGN.md 0, 18: the coach line replaces the hint line; its tap does the advised action
  let advice: Advice | null = null;
  const coachLabel = h('b', { class: 'coach-label' });
  const coachReason = h('span', { class: 'coach-reason' });
  const coachGo = h('span', { class: 'coach-go', text: 'Do it' });
  const coach = h('button', {
    class: 'coach idea',
    type: 'button',
    title: 'The coach: the single best next move, with the reason. Advice only; the tap does it.',
    onClick: () => {
      // the controller plays the click on an accepted action (DESIGN.md 19), so none here
      if (advice?.action && hooks.dispatch) hooks.dispatch(advice.action);
    },
  },
  h('span', { class: 'coach-icon' }, icon('trophy')),
  h('span', { class: 'coach-text' }, coachLabel, ' ', coachReason),
  coachGo);

  const el = h('div', { class: 'hud' },
    h('div', { class: 'pills', attrs: { 'data-tour': 'pills' } }, cash.el, profit.el, fcf.el, stake.el),
    capBar,
    h('div', { class: 'hud-row' }, calendar, countdown, pause, help, speaker),
    h('div', { class: 'lines' }, why, coach));

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
    profit.setIcon(p < -0.5 ? 'trendDown' : 'trendUp');
    profit.el.classList.toggle('down', p < -0.5);
    const f = ledger.fcfOf(state.book);
    fcf.value.textContent = money(f);
    tone(fcf.value, f);

    // DESIGN.md 0: the stake is the score if the buzzer went now, value × your share
    const value = Math.max(0, state.valuation.value);
    stake.value.textContent = money(value * state.founderShare);
    stakeSub.textContent = `${percent(state.founderShare)} of ${money(value)}`;
    const sp = sparkPaths(stakeHistory(state));
    sparkLine.setAttribute('d', sp.line);
    sparkArea.setAttribute('d', sp.area);
    spark.classList.toggle('down', !sp.up);
    renderCapBar(state);

    const cal = selectors.calendar(state.day);
    calHead.textContent = `Year ${cal.year} · Q${cal.quarter}`;
    calMonth.textContent = cal.monthName;
    calDay.textContent = `day ${cal.dayOfMonth}`;
    calendar.title = `${cal.label} · game day ${state.day} · month ${cal.month + 1}`;

    // DESIGN.md 13: whole sentences; the title keeps the full text reachable if the two-row clamp ever cuts one
    const w = whyLine(state);
    why.textContent = w;
    why.title = w;
    why.hidden = !w;

    advice = advise(state);
    coachLabel.textContent = advice.label;
    coachReason.textContent = advice.reason;
    const actionable = advice.action !== null && !!hooks.dispatch;
    coach.className = `coach ${advice.urgency}${actionable ? ' has-action' : ''}`;
    coach.setAttribute('aria-disabled', actionable ? 'false' : 'true');
    coachGo.hidden = !actionable;
    coach.hidden = state.status !== 'playing';
    syncSpeaker();
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

  return { el, update, tickClock, setPaused };
}
