/**
 * Entry point: the start screen, then the round — the HUD with the countdown, the live
 * leaderboard strip, canvas + renderer, the control board, the Books sheet, cards,
 * toasts, the result screen — and the animation loop (controller.tick, the countdown,
 * then renderer.frame). DESIGN.md sections 0, 2 and 13.
 */
import './ui/styles.css';
import type { GameState } from './sim';
import { createCards } from './ui/cards';
import { createController } from './ui/controller';
import type { ShellController, Tone } from './ui/controller';
import { createHud } from './ui/hud';
import { createLeaderboard } from './ui/leaderboard';
import { createLeaderStrip } from './ui/leaderstrip';
import { createBoard } from './ui/panels/board';
import { BOOKS_VALUATION_TAB, booksSheet } from './ui/panels/books';
import { h } from './ui/panels/dom';
import { createSheetHost } from './ui/panels/sheet';
import { createOfficeRenderer } from './ui/renderer';
import { createResult } from './ui/result';
import { mountStart } from './ui/start';
import type { StartOptions } from './ui/start';

/** Design size of the portrait column (DESIGN.md 2). */
const DESIGN_W = 420;
const DESIGN_H = 840;
/** Frame time handed to the renderer is capped so a hidden tab does not fast-forward animations. */
const MAX_RENDER_DT = 250;
const TOAST_MS = 3200;

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app missing');
const app: HTMLElement = appEl;

function fitColumn(): void {
  // the body's box, not the window: a host may pad the root for phone safe areas
  const vw = document.body.clientWidth || window.innerWidth;
  const vh = document.body.clientHeight || window.innerHeight;
  const s = Math.min(vw / DESIGN_W, vh / DESIGN_H);
  app.style.setProperty('--s', s.toFixed(4));
  app.classList.toggle('floating', vw - DESIGN_W * s > 12 || vh - DESIGN_H * s > 12);
}
fitColumn();
window.addEventListener('resize', fitColumn);
window.visualViewport?.addEventListener('resize', fitColumn);

/** One leaderboard for the page: the start screen previews it, every round posts to it. */
const leaderboard = createLeaderboard();

interface Mounted {
  destroy(): void;
}

let game: Mounted | null = null;
let unmountStart: (() => void) | null = null;

function showStart(): void {
  game?.destroy();
  game = null;
  unmountStart?.();
  app.replaceChildren();
  unmountStart = mountStart(app, leaderboard, beginRound);
}

/**
 * DESIGN.md 0: register the run on the leaderboard (status playing, value 0), then
 * mount the round with a fresh deadline. Play again lands here too: same world, same name.
 */
function beginRound(opts: StartOptions): void {
  unmountStart?.();
  unmountStart = null;
  game?.destroy();
  game = null;
  app.replaceChildren();
  leaderboard.start(opts.name, opts.seed).catch(() => undefined);
  game = mountGame(opts);
}

declare global {
  interface Window {
    /** Dev-only handle for poking the shell from the console (e.g. __brightbyte.dispatch({ type: 'hireRole', role: 'product' })). */
    __brightbyte?: ShellController;
  }
}

function mountGame(opts: StartOptions): Mounted {
  const controller = createController(opts.seed, leaderboard, { playerName: opts.name });
  if (import.meta.env.DEV) window.__brightbyte = controller;

  // ---- stage: canvas, overlays
  const canvas = h('canvas', { attrs: { 'aria-label': 'Office floor' } });
  const toasts = h('div', { class: 'toasts' });
  const waiting = h('button', { class: 'waiting-chip', type: 'button', text: 'A card is waiting', onClick: () => cards.show() });
  waiting.hidden = true;
  const stage = h('div', { class: 'stage' }, canvas, toasts, waiting);

  // ---- layers: sheets, then cards, then the result screen on top
  const sheetLayer = h('div', { class: 'layer' });
  const cardLayer = h('div', { class: 'layer' });
  const resultLayer = h('div', { class: 'layer' });

  const sheets = createSheetHost(sheetLayer, () => controller.state);
  const cards = createCards(controller, cardLayer);
  const hud = createHud({
    onBooks: () => sheets.toggle(booksSheet(controller)),
    onValue: () => sheets.toggle(booksSheet(controller), BOOKS_VALUATION_TAB),
  });
  const strip = createLeaderStrip(leaderboard);
  const board = createBoard(controller);
  const result = createResult(controller, resultLayer, { onPlayAgain: () => beginRound(opts) });

  const column = h('div', { class: 'shell', style: 'display:contents' }, hud.el, strip.el, stage, board.el, sheetLayer, cardLayer, resultLayer);
  app.appendChild(column);

  // ---- renderer
  const renderer = createOfficeRenderer(canvas, controller);
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(stage);
  const onResize = (): void => renderer.resize();
  window.addEventListener('resize', onResize);
  renderer.resize();

  // ---- toasts
  function showToast(text: string, tone: Tone): void {
    const t = h('div', { class: `toast ${tone}`, text });
    toasts.appendChild(t);
    while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 320);
    }, TOAST_MS);
  }
  const offToast = controller.onToast(showToast);

  // ---- state → DOM (only on state change, never per frame)
  const syncWaiting = (): void => {
    const state = controller.state;
    waiting.hidden = !(state.status === 'playing' && state.card && !cards.isShowing);
  };
  const refresh = (state: GameState): void => {
    hud.update(state);
    board.update(state);
    sheets.update();
    cards.update(state);
    if (state.status !== 'playing') sheets.close();
    result.update(state);
    syncWaiting();
  };
  const offState = controller.subscribe(refresh);
  refresh(controller.state);
  cardLayer.addEventListener('click', () => setTimeout(syncWaiting, 0));

  // ---- keyboard: Escape closes the Books; there is nothing else to key (DESIGN.md 0)
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    sheets.close();
  };
  window.addEventListener('keydown', onKey);

  // ---- the loop: sim ticks on wall-clock, the countdown is patched, then one frame
  let last = performance.now();
  let raf = 0;
  const loop = (now: number): void => {
    const dt = Math.max(0, now - last);
    last = now;
    controller.tick(dt);
    hud.tickClock(controller.remainingMs);
    renderer.frame(Math.min(dt, MAX_RENDER_DT));
    raf = requestAnimationFrame(loop);
  };
  hud.tickClock(controller.remainingMs);
  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      offToast();
      offState();
      strip.destroy();
      result.destroy();
      renderer.destroy();
      sheets.destroy();
      column.remove();
      if (window.__brightbyte === controller) delete window.__brightbyte;
    },
  };
}

showStart();
