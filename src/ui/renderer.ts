/**
 * The office floor on canvas: rooms, furniture, people, walking customers, coin
 * popups, placement mode and taps. DESIGN.md sections 3, 5, 13.
 *
 * The shell owns the DOM, the RAF loop (it calls frame(dt) and resize()), the
 * controller and every panel; this module only draws into the canvas it is
 * given and reports taps. The geometry, the scene cache and the crowd live in
 * ./office/* as pure functions that are unit tested without a DOM.
 */
import { CONFIG } from '../sim/config';
import { openReceivables } from '../sim/ledger';
import { smbPrice } from '../sim/selectors';
import type { AssetKind, GameState } from '../sim/types';
import type { GameController, OfficeRenderer } from './api';
import { applyVisual } from './office/choreo';
import type { ChoreoContext } from './office/choreo';
import { computeLayout, hitCell, roomAt } from './office/layout';
import type { Layout } from './office/layout';
import { createPainter, paintFrame, setPainterCell, setPainterScale } from './office/paint';
import type { FrameInfo } from './office/paint';
import { buildScene } from './office/scene';
import type { Scene, SeatInfo } from './office/scene';
import { clamp } from './office/util';
import type { Pt } from './office/util';
import { createCrowd, rescaleCrowd, resetCrowd, stepCrowd } from './office/walkers';

/** CSS px a pointer may travel between down and up and still count as a tap */
const TAP_SLOP = 10;
/** CSS px kept free around the lot so the slab shadows have room */
export const LOT_PAD = 6;
/** the longest step the animation takes in one frame, ms (a hidden tab does not fast-forward) */
const MAX_DT_MS = 100;

export function createOfficeRenderer(canvas: HTMLCanvasElement, controller: GameController): OfficeRenderer {
  const ctx = canvas.getContext('2d');
  const painter = ctx ? createPainter(ctx) : null;
  const crowd = createCrowd(CONFIG.ui.maxWalkers, 1);
  /** last known seat of every person who ever sat on the floor (for 'leave') */
  const lastSeats = new Map<string, SeatInfo>();
  /** last known centre of every room that ever existed (for 'room' close pops) */
  const lastRoomCentres = new Map<string, Pt>();

  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  /** backing-store px per CSS px: the device pixel ratio times the shell's column scale */
  let scaleX = 1;
  let scaleY = 1;
  let layout: Layout | null = null;
  let scene: Scene | null = null;
  let time = 0;
  let destroyed = false;

  // scene cache signature: rebuilt when the subscription fires or any of these change
  let dirty = true;
  let sigState: GameState | null = null;
  let sigDay = -1;
  let sigRooms = -1;
  let sigPeople = -1;
  let sigAssets = -1;
  let sigFounderRole = '';

  // pointer
  const pt: Pt = { x: 0, y: 0 };
  let pressed = false;
  let pressId = -1;
  let pressX = 0;
  let pressY = 0;
  let pressedSpot: { x: number; y: number } | null = null;

  const info: FrameInfo = { time: 0, ar: 0, openInvoices: 0, placement: null, selectedRoomId: null, pressedSpot: null };

  const choreo: ChoreoContext = {
    smbPrice: 0,
    seatOf: (id) => scene?.seats.get(id) ?? null,
    lastSeatOf: (id) => lastSeats.get(id) ?? null,
    lastRoomCentre: (id) => lastRoomCentres.get(id) ?? null,
    assetPoint: (kind: AssetKind): Pt | null => {
      if (!scene) return null;
      const assets = controller.state.assets;
      for (let i = assets.length - 1; i >= 0; i--) {
        const a = assets[i];
        if (a.kind === kind && a.roomId) {
          const v = scene.byId.get(a.roomId);
          if (v) return v.centre;
        }
      }
      return null;
    },
  };

  const unsubscribe = controller.subscribe(() => {
    dirty = true;
  });

  // ---------------------------------------------------------------- sizing and caches

  function resize(): void {
    if (destroyed) return;
    dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // the shell scales the 420×840 column with a CSS transform (DESIGN.md 2): size the backing
    // store from the on-screen rectangle so the drawing stays crisp, and keep drawing in CSS px
    const r = canvas.getBoundingClientRect();
    const onW = r.width > 0 ? r.width : w;
    const onH = r.height > 0 ? r.height : h;
    const bw = Math.max(1, Math.round(onW * dpr));
    const bh = Math.max(1, Math.round(onH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    cssW = w;
    cssH = h;
    scaleX = w > 0 ? bw / w : dpr;
    scaleY = h > 0 ? bh / h : dpr;
    if (painter) setPainterScale(painter, scaleX, scaleY);
  }

  function ensureLayout(floors: 1 | 2): Layout {
    if (layout && layout.width === cssW && layout.height === cssH && layout.floors === floors) return layout;
    const next = computeLayout({ width: cssW, height: cssH, floors, pad: LOT_PAD });
    if (layout) rescaleCrowd(crowd, layout, next);
    else crowd.cell = next.cell;
    layout = next;
    if (painter) setPainterCell(painter, next.cell);
    scene = null;
    return next;
  }

  function sceneStale(st: GameState): boolean {
    return (
      dirty ||
      scene === null ||
      st !== sigState ||
      st.day !== sigDay ||
      st.rooms.length !== sigRooms ||
      st.people.length !== sigPeople ||
      st.assets.length !== sigAssets ||
      st.founderRole !== sigFounderRole
    );
  }

  function rebuildScene(st: GameState, l: Layout): Scene {
    const next = buildScene(st, l);
    for (const [id, seat] of next.seats) lastSeats.set(id, seat);
    for (const v of next.rooms) lastRoomCentres.set(v.room.id, v.centre);
    scene = next;
    dirty = false;
    sigState = st;
    sigDay = st.day;
    sigRooms = st.rooms.length;
    sigPeople = st.people.length;
    sigAssets = st.assets.length;
    sigFounderRole = st.founderRole;
    return next;
  }

  function countOpenInvoices(st: GameState): number {
    let n = 0;
    for (let i = 0; i < st.invoices.length; i++) if (st.invoices[i].status === 'open') n++;
    return n;
  }

  // ---------------------------------------------------------------- the frame

  function frame(dtMs: number): void {
    if (destroyed || !ctx || !painter) return;
    const dt = clamp(dtMs, 0, MAX_DT_MS) / 1000;
    time += dt;
    if (cssW <= 0 || cssH <= 0) {
      resize();
      if (cssW <= 0 || cssH <= 0) return;
    }
    const st = controller.state;
    if (st !== sigState) {
      // a new game: the old crowd belongs to another world
      resetCrowd(crowd);
      lastSeats.clear();
      lastRoomCentres.clear();
      dirty = true;
    }
    const l = ensureLayout(st.floors);
    const sc = sceneStale(st) ? rebuildScene(st, l) : (scene as Scene);

    const evs = controller.drainVisuals();
    if (evs.length > 0) {
      choreo.smbPrice = smbPrice(st);
      for (let i = 0; i < evs.length; i++) applyVisual(crowd, sc, evs[i], choreo);
    }
    stepCrowd(crowd, dt);

    info.time = time;
    info.ar = openReceivables(st);
    info.openInvoices = countOpenInvoices(st);
    info.placement = controller.placement;
    info.selectedRoomId = controller.selectedRoomId;
    info.pressedSpot = pressedSpot;

    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    paintFrame(painter, l, sc, crowd, info);
  }

  // ---------------------------------------------------------------- pointer input

  /** client coords → canvas CSS coords (the shell may scale the column with a CSS transform) */
  function toCanvas(e: PointerEvent): void {
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? cssW / r.width : 1;
    const sy = r.height > 0 ? cssH / r.height : 1;
    pt.x = (e.clientX - r.left) * sx;
    pt.y = (e.clientY - r.top) * sy;
  }

  function spotAt(x: number, y: number): { x: number; y: number } | null {
    const pm = controller.placement;
    if (!pm || !layout) return null;
    const cell = hitCell(layout, x, y);
    if (!cell || cell.floor !== pm.floor) return null;
    for (let i = 0; i < pm.spots.length; i++) {
      const s = pm.spots[i];
      if (s.x === cell.x && s.y === cell.y) return s;
    }
    return null;
  }

  function tap(x: number, y: number): void {
    if (!layout) return;
    const pm = controller.placement;
    if (pm) {
      // placement mode: only a valid spot does anything (DESIGN 5)
      const spot = spotAt(x, y);
      if (!spot) return;
      // a refusal is toasted by the shell's dispatch (DESIGN 13: the shell owns toasts), never re-reported here
      controller.dispatch({ type: 'placeRoom', kind: pm.kind, size: pm.size, floor: pm.floor, x: spot.x, y: spot.y });
      controller.setPlacement(null);
      return;
    }
    const cell = hitCell(layout, x, y);
    const room = cell ? roomAt(controller.state.rooms, cell.floor, cell.x, cell.y) : undefined;
    controller.selectRoom(room ? room.id : null);
  }

  function onDown(e: PointerEvent): void {
    if (pressed || e.button !== 0) return;
    pressed = true;
    pressId = e.pointerId;
    toCanvas(e);
    pressX = pt.x;
    pressY = pt.y;
    pressedSpot = spotAt(pt.x, pt.y);
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety; taps still work without it
    }
  }

  function onMove(e: PointerEvent): void {
    if (!pressed || e.pointerId !== pressId) return;
    toCanvas(e);
    if (Math.hypot(pt.x - pressX, pt.y - pressY) > TAP_SLOP) {
      pressed = false;
      pressedSpot = null;
    }
  }

  function onUp(e: PointerEvent): void {
    if (!pressed || e.pointerId !== pressId) return;
    pressed = false;
    pressedSpot = null;
    toCanvas(e);
    if (Math.hypot(pt.x - pressX, pt.y - pressY) <= TAP_SLOP) tap(pt.x, pt.y);
  }

  function onCancel(e: PointerEvent): void {
    if (e.pointerId !== pressId) return;
    pressed = false;
    pressedSpot = null;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    unsubscribe();
    resetCrowd(crowd);
    scene = null;
    layout = null;
  }

  return { resize, frame, destroy };
}
