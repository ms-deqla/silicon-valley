/**
 * Entry point: the start screen, then the round — the HUD with the countdown, the live
 * leaderboard strip, canvas + renderer, the control board, the Books sheet, cards,
 * toasts, the result screen — and the animation loop (controller.tick, the countdown,
 * then renderer.frame). On the first Start the coach-mark tour runs over the mounted
 * round and the clock starts when it closes; "?" opens the Playbook while the clock runs;
 * a practice run posts nothing. DESIGN.md sections 0, 2, 13, 18 and 19.
 */
import './ui/styles.css';
import type { GameState } from './sim';
import { createAudio } from './ui/audio';
import { createCards } from './ui/cards';
import { createController } from './ui/controller';
import type { ShellController, Tone } from './ui/controller';
import { createHud } from './ui/hud';
import { COLOR_HEX, createLeaderboard } from './ui/leaderboard';
import { createLeaderStrip } from './ui/leaderstrip';
import { createBoard } from './ui/panels/board';
import { BOOKS_VALUATION_TAB, booksSheet } from './ui/panels/books';
import { h } from './ui/panels/dom';
import { createSheetHost } from './ui/panels/sheet';
import { openPlaybook } from './ui/playbook';
import type { PlaybookHandle } from './ui/playbook';
import { createOfficeRenderer } from './ui/renderer';
import { createResult } from './ui/result';
import { mountStart } from './ui/start';
import type { StartOptions } from './ui/start';
import { markTourSeen, startTour, tourSeen } from './ui/tutorial';
import type { TourHandle } from './ui/tutorial';

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
/** One audio for the page (DESIGN.md 19): started on the Start tap, the first user gesture. */
const audio = createAudio();

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
  unmountStart = mountStart(app, leaderboard, beginRound, { audio });
}

/**
 * DESIGN.md 0: register the run on the leaderboard (status playing, value 0) unless it is
 * practice, then mount the round. The Start tap is the user gesture the audio needs. Play
 * again lands here too: same world, same name, same colour.
 */
function beginRound(opts: StartOptions): void {
  unmountStart?.();
  unmountStart = null;
  game?.destroy();
  game = null;
  app.replaceChildren();
  audio.start();
  if (!opts.practice) leaderboard.start(opts.name, opts.seed, opts.color).catch(() => undefined);
  game = mountGame(opts);
}

declare global {
  interface Window {
    /** Dev-only handle for poking the shell from the console (e.g. __brightbyte.dispatch({ type: 'hireRole', role: 'product' })). */
    __brightbyte?: ShellController;
  }
}

function mountGame(opts: StartOptions): Mounted {
  const controller = createController(opts.seed, leaderboard, { playerName: opts.name, practice: opts.practice, audio });
  if (import.meta.env.DEV) window.__brightbyte = controller;

  // ---- stage: canvas, overlays
  const canvas = h('canvas', { attrs: { 'aria-label': 'Office floor' } });
  const toasts = h('div', { class: 'toasts' });
  const waiting = h('button', { class: 'waiting-chip', type: 'button', text: 'A card is waiting', onClick: () => cards.show() });
  waiting.hidden = true;
  const stage = h('div', { class: 'stage', attrs: { 'data-tour': 'office' } }, canvas, toasts, waiting);

  // ---- layers: sheets, then cards, then the result screen on top
  const sheetLayer = h('div', { class: 'layer' });
  const cardLayer = h('div', { class: 'layer' });
  const resultLayer = h('div', { class: 'layer' });

  const sheets = createSheetHost(sheetLayer, () => controller.state);
  const cards = createCards(controller, cardLayer);
  const hud = createHud({
    onBooks: () => sheets.toggle(booksSheet(controller)),
    onValue: () => sheets.toggle(booksSheet(controller), BOOKS_VALUATION_TAB),
    // DESIGN.md 0, 18, 19: the "?" opens the Playbook, the coach line's tap dispatches, the speaker binds the page's audio
    onHelp: () => toggleHelp(),
    onPause: () => controller.togglePause(),
    dispatch: (action) => controller.dispatch(action),
    audio,
    playerColor: COLOR_HEX[opts.color],
  });
  hud.el.setAttribute('data-tour', 'hud');
  // DESIGN.md 0, Pause: the HUD follows the controller's pause state
  const offPause = controller.onPause((paused) => hud.setPaused(paused));
  const strip = createLeaderStrip(leaderboard);
  const board = createBoard(controller);
  board.el.setAttribute('data-tour', 'board');
  const result = createResult(controller, resultLayer, { onPlayAgain: () => beginRound(opts), code: opts.code });

  const column = h('div', { class: 'shell', style: 'display:contents' }, hud.el, strip.el, stage, board.el, sheetLayer, cardLayer, resultLayer);
  app.appendChild(column);

  // ---- the Playbook ("?"): the clock keeps running (DESIGN.md 0)
  let playbook: PlaybookHandle | null = null;
  function toggleHelp(): void {
    if (playbook) {
      playbook.close();
      return;
    }
    playbook = openPlaybook(app, { onClose: () => { playbook = null; } });
  }

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

  // ---- keyboard: Escape closes the Books (the Playbook and the tour handle their own Escape); "?" opens the Playbook; Space pauses
  const onKey = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (ev.key === 'Escape') {
      if (!playbook) sheets.close();
      return;
    }
    if (ev.key === '?' && !tour && controller.state.status === 'playing') toggleHelp();
    // Space pauses wherever focus is (preventDefault also stops a focused button from firing on the key-up)
    if (ev.key === ' ' && !tour && controller.state.status === 'playing') {
      ev.preventDefault();
      controller.togglePause();
    }
  };
  window.addEventListener('keydown', onKey);

  // ---- the loop: sim ticks on wall-clock, the countdown is patched, then one frame
  let last = performance.now();
  let raf = 0;
  let paintFailed = false;
  const loop = (now: number): void => {
    const dt = Math.max(0, now - last);
    last = now;
    controller.tick(dt);
    hud.tickClock(controller.remainingMs);
    // a painting error must not stop the round: the clock never stops (DESIGN.md 0); it is reported once
    try {
      renderer.frame(Math.min(dt, MAX_RENDER_DT));
    } catch (e) {
      if (!paintFailed) {
        paintFailed = true;
        console.error(e);
      }
    }
    raf = requestAnimationFrame(loop);
  };
  hud.tickClock(controller.remainingMs);
  raf = requestAnimationFrame(loop);

  // ---- DESIGN.md 0, Tutorial: on the first Start the tour runs with the clock held at 10:00; it starts when the tour closes
  let tour: TourHandle | null = null;
  if (tourSeen()) {
    controller.startClock();
  } else {
    tour = startTour({
      root: app,
      controller,
      onDone: () => {
        tour = null;
        markTourSeen();
        controller.startClock();
      },
    });
  }

  return {
    destroy() {
      cancelAnimationFrame(raf);
      tour?.destroy();
      tour = null;
      playbook?.close();
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      offToast();
      offState();
      offPause();
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
