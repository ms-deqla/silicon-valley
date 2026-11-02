/**
 * Bottom sheets: one open at a time, re-rendered on every state change while open.
 * Re-renders are deferred while a pointer is down, while a select's native popup is up,
 * or while a text field inside the sheet has focus, so a tap, a slider drag or a pick
 * never lands on an element that was just replaced.
 */
import type { GameState } from '../../sim';
import { h } from './dom';

export interface SheetApi {
  close(): void;
  setTab(id: string): void;
  rerender(): void;
}

export interface SheetSpec {
  id: string;
  title: string;
  tabs?: { id: string; label: string }[];
  render(body: HTMLElement, state: GameState, tab: string, api: SheetApi): void;
  onClose?(): void;
}

export interface SheetHost {
  /** Open a sheet, on the given tab when one is named (else the remembered or first tab). */
  open(spec: SheetSpec, tab?: string): void;
  close(): void;
  /** Close when the same sheet is open (on that tab, when one is named), otherwise open it. */
  toggle(spec: SheetSpec, tab?: string): void;
  /** Re-render the open sheet (called on every state change). */
  update(): void;
  readonly openId: string | null;
  /** Close and drop the window listeners (when the shell unmounts). */
  destroy(): void;
}

export function createSheetHost(layer: HTMLElement, getState: () => GameState): SheetHost {
  let current: SheetSpec | null = null;
  let tab = '';
  const tabMemory = new Map<string, string>();
  let held = false;
  let dirty = false;

  const backdrop = h('div', { class: 'sheet-backdrop', onClick: () => close() });
  const titleEl = h('h2', { class: 'sheet-title' });
  const tabsEl = h('div', { class: 'sheet-tabs' });
  const body = h('div', { class: 'sheet-body' });
  const sheet = h('div', { class: 'sheet', attrs: { role: 'dialog' } },
    h('div', { class: 'sheet-head' },
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'sheet-head-row' },
        titleEl,
        h('button', { class: 'icon-btn', type: 'button', text: '×', title: 'Close', attrs: { 'aria-label': 'Close' }, onClick: () => close() }))),
    tabsEl,
    body);

  sheet.addEventListener('pointerdown', () => {
    held = true;
  }, true);
  /** A select's gesture ends at its change or blur, not at pointerup: its native popup is open in between. */
  const selectIn = (ev: Event): boolean => ev.target instanceof HTMLSelectElement && body.contains(ev.target);
  const release = (ev?: Event): void => {
    if (!held) return;
    if (ev && selectIn(ev)) return;
    held = false;
    if (dirty) setTimeout(() => { if (dirty) rerender(); }, 0);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  body.addEventListener('change', (ev) => {
    if (selectIn(ev)) release();
  });
  body.addEventListener('focusout', (ev) => {
    if (selectIn(ev)) held = false;
    if (dirty) setTimeout(() => { if (dirty) rerender(); }, 0);
  });

  const api: SheetApi = {
    close: () => close(),
    setTab: (id) => {
      tab = id;
      if (current) tabMemory.set(current.id, id);
      renderTabs();
      rerender(true);
    },
    rerender: () => rerender(true),
  };

  function renderTabs(): void {
    tabsEl.replaceChildren();
    if (!current?.tabs) {
      tabsEl.hidden = true;
      return;
    }
    tabsEl.hidden = false;
    for (const t of current.tabs) {
      tabsEl.appendChild(h('button', {
        class: `tab${t.id === tab ? ' active' : ''}`,
        type: 'button',
        text: t.label,
        onClick: () => api.setTab(t.id),
      }));
    }
  }

  /** Only text entry needs the focus guard: a range input keeps focus long after its drag, which `held` already covers. */
  function focusedInput(): boolean {
    const a = document.activeElement;
    if (!a || !body.contains(a)) return false;
    if (a instanceof HTMLTextAreaElement) return true;
    return a instanceof HTMLInputElement && a.type !== 'range' && a.type !== 'checkbox' && a.type !== 'radio';
  }

  function rerender(force = false): void {
    if (!current) return;
    if (!force && (held || focusedInput())) {
      dirty = true;
      return;
    }
    dirty = false;
    const top = body.scrollTop;
    body.replaceChildren();
    current.render(body, getState(), tab, api);
    body.scrollTop = top;
  }

  function open(spec: SheetSpec, wantTab?: string): void {
    const previous = current;
    current = spec;
    if (previous && previous.id !== spec.id) previous.onClose?.();
    if (wantTab !== undefined && spec.tabs?.some((t) => t.id === wantTab)) tabMemory.set(spec.id, wantTab);
    tab = tabMemory.get(spec.id) ?? spec.tabs?.[0]?.id ?? '';
    titleEl.textContent = spec.title;
    renderTabs();
    if (!backdrop.isConnected) layer.append(backdrop, sheet);
    body.scrollTop = 0;
    dirty = false;
    body.replaceChildren();
    spec.render(body, getState(), tab, api);
  }

  function close(): void {
    if (!current) return;
    const closing = current;
    current = null;
    dirty = false;
    backdrop.remove();
    sheet.remove();
    closing.onClose?.();
  }

  return {
    open,
    close,
    toggle(spec, wantTab) {
      if (current?.id === spec.id && (wantTab === undefined || wantTab === tab)) close();
      else open(spec, wantTab);
    },
    update() {
      rerender();
    },
    get openId() {
      return current?.id ?? null;
    },
    destroy() {
      close();
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
    },
  };
}
