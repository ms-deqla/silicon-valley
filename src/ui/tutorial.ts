/**
 * The coach-mark tour on the first Start (DESIGN.md 18): nine stops over the real,
 * mounted round while the clock is not running yet. Each stop dims the screen with a
 * cut-out around the control it explains (found by a data-tour id, else by the element's
 * existing class; a stop with nothing to point at gets a centred card), a card with the
 * text, Next / Skip (Done on the last stop), and Escape = skip. The texts are the nine
 * coach sections of playbook.ts, every number generated from CONFIG/RULES. onDone fires
 * once, on finish or skip; main.ts starts the clock from it. tourSeen / markTourSeen keep
 * the "already seen" flag in localStorage (wrapped: a browser that refuses storage shows
 * the tour every time, which beats a page that fails).
 */
import type { GameController } from './api';
import { h } from './panels/dom';
import { coachSections, styleOnce } from './playbook';
import type { PlaybookSection } from './playbook';

export interface TourHandle {
  destroy(): void;
}

export interface TourStop {
  id: string;
  title: string;
  text: string;
  /** selectors tried in order against the mounted round; none matching = no cut-out */
  targets: string[];
}

const TOUR_KEY = 'sv.tour.v1';

/**
 * Where each stop points. A `data-tour` id first (main.ts and leaderstrip.ts set them on
 * the elements they own; the HUD and board may carry them too), then the element's class
 * as the shell draws it today, so a restyle that keeps the class still gets the cut-out.
 */
const TARGETS: Record<string, string[]> = {
  goal: ['[data-tour="countdown"]', '.countdown'],
  pills: ['[data-tour="pills"]', '.pills'],
  product: ['[data-tour="product"]', '.tile[data-key="product"]', '.board-row.product'],
  marketing: ['[data-tour="marketing"]', '.tile[data-key="marketing"]', '.board-row.marketing'],
  sales: ['[data-tour="sales"]', '.tile[data-key="sales"]', '.board-row.sales'],
  support: ['[data-tour="support"]', '.tile[data-key="support"]', '.board-row.support'],
  assets: ['[data-tour="assets"]', '.tile-pair', '.board-row.assets'],
  // no card is open at the start: the office, where investors and events walk in
  cards: ['[data-tour="cards"]', '[data-tour="office"]'],
  strip: ['[data-tour="strip"]', '.leaderstrip'],
};

function stopOf(section: PlaybookSection): TourStop {
  return { id: section.id, title: section.title, text: section.paragraphs.join(' '), targets: TARGETS[section.id] ?? [] };
}

/** The nine stops, in order, texts from the Playbook (one generator, no drift). */
export function tourStops(): TourStop[] {
  return coachSections().map(stopOf);
}

export function tourSeen(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TOUR_KEY) === '1';
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, '1');
  } catch {
    // storage refused: the tour runs again next time, nothing else changes
  }
}

/** For a "Show the tour again" control: forgets the flag. */
export function forgetTour(): void {
  try {
    localStorage.removeItem(TOUR_KEY);
  } catch {
    // nothing to forget
  }
}

/** padding of the cut-out around the target, in column px */
const HOLE_PAD = 6;
/** gap between the cut-out and the card */
const CARD_GAP = 10;
const EDGE = 12;

const TOUR_CSS = `
.tour { position: absolute; inset: 0; z-index: 30; overflow: hidden; }
.tour.dim { background: rgba(20, 22, 30, 0.55); }
.tour-hole { position: absolute; border-radius: 14px; box-shadow: 0 0 0 2000px rgba(20, 22, 30, 0.55); outline: 2px solid rgba(255, 255, 255, 0.9); pointer-events: none; }
.tour-card { position: absolute; left: var(--gutter, 16px); right: var(--gutter, 16px); padding: 14px 16px 12px; border-radius: 18px; background: #fff; color: var(--ink, #22242b); box-shadow: 0 18px 40px rgba(20, 24, 40, 0.28); display: flex; flex-direction: column; gap: 6px; }
.tour-step { font-size: 11px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3, #9094a0); }
.tour-title { font-size: 18px; font-weight: 800; line-height: 1.2; }
.tour-text { font-size: 13.5px; line-height: 1.42; }
.tour-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
.tour-actions .btn { min-width: 96px; }
@media (prefers-reduced-motion: no-preference) { .tour-hole { transition: left 0.18s ease-out, top 0.18s ease-out, width 0.18s ease-out, height 0.18s ease-out; } }
`;

/** Runs the nine stops over the mounted round; onDone fires on finish or skip. */
export function startTour(opts: { root: HTMLElement; controller: GameController; onDone: () => void }): TourHandle {
  // the tour reads nothing from the sim: the stops' numbers come from config (DESIGN.md 18)
  void opts.controller;
  const root = opts.root;
  styleOnce('sv-tour-style', TOUR_CSS);
  const stops = tourStops();
  let index = 0;
  let alive = true;

  const hole = h('div', { class: 'tour-hole' });
  const step = h('div', { class: 'tour-step' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text' });
  const skip = h('button', { class: 'btn tour-skip', type: 'button', text: 'Skip', onClick: () => finish() });
  const next = h('button', { class: 'btn primary tour-next', type: 'button', text: 'Next', onClick: () => advance() });
  const card = h('div', { class: 'tour-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' } },
    step, title, text, h('div', { class: 'tour-actions' }, skip, next));
  const layer = h('div', { class: 'tour' }, hole, card);

  function targetOf(stop: TourStop): Element | null {
    for (const sel of stop.targets) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /**
   * The column (#app) is scaled with a transform to fit the viewport (main.ts), so screen
   * rects are divided by the scale to land in the column's own coordinates.
   */
  function place(): void {
    if (!alive) return;
    const stop = stops[index];
    const rr = root.getBoundingClientRect();
    const scale = root.offsetWidth > 0 && rr.width > 0 ? rr.width / root.offsetWidth : 1;
    const W = root.offsetWidth || rr.width;
    const H = root.offsetHeight || rr.height;
    const target = targetOf(stop);
    const cardH = card.offsetHeight;
    if (target) {
      const tr = target.getBoundingClientRect();
      const x = (tr.left - rr.left) / scale - HOLE_PAD;
      const y = (tr.top - rr.top) / scale - HOLE_PAD;
      const w = tr.width / scale + 2 * HOLE_PAD;
      const hh = tr.height / scale + 2 * HOLE_PAD;
      hole.hidden = false;
      layer.classList.remove('dim');
      hole.style.left = `${Math.max(0, x).toFixed(1)}px`;
      hole.style.top = `${Math.max(0, y).toFixed(1)}px`;
      hole.style.width = `${Math.min(W, w).toFixed(1)}px`;
      hole.style.height = `${hh.toFixed(1)}px`;
      // the card goes under the target when the target sits in the upper half, above it otherwise
      const below = y + hh / 2 < H / 2;
      const top = below ? y + hh + CARD_GAP : y - CARD_GAP - cardH;
      card.style.top = `${Math.max(EDGE, Math.min(H - cardH - EDGE, top)).toFixed(1)}px`;
    } else {
      hole.hidden = true;
      layer.classList.add('dim');
      card.style.top = `${Math.max(EDGE, (H - cardH) / 2).toFixed(1)}px`;
    }
  }

  function show(): void {
    const stop = stops[index];
    step.textContent = `${index + 1} of ${stops.length}`;
    title.textContent = stop.title;
    text.textContent = stop.text;
    next.textContent = index === stops.length - 1 ? 'Done' : 'Next';
    place();
    next.focus({ preventScroll: true });
  }

  function advance(): void {
    if (!alive) return;
    if (index >= stops.length - 1) {
      finish();
      return;
    }
    index += 1;
    show();
  }

  function cleanup(): void {
    if (!alive) return;
    alive = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    layer.remove();
  }

  function finish(): void {
    if (!alive) return;
    cleanup();
    opts.onDone();
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish();
    }
  };
  // capture, so the shell's own Escape handler (sheets) does not see the key first
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);

  root.appendChild(layer);
  show();
  // the first measure can run before fonts and layout settle: place once more on the next frame
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => place());

  return {
    destroy() {
      cleanup();
    },
  };
}
