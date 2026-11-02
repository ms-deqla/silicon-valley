/**
 * Tiny DOM helpers shared by the shell. No framework: elements are built once
 * and replaced on state change (sheets) or patched in place (HUD).
 */
import type { Verdict } from '../../sim';
import { skillText } from '../format';

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  text?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string | number;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  style?: string;
  attrs?: Record<string, string>;
  onClick?: (ev: MouseEvent) => void;
  onInput?: (ev: Event) => void;
  onChange?: (ev: Event) => void;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) {
      append(el, c);
      continue;
    }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs.class) el.className = attrs.class;
  if (attrs.text !== undefined) el.textContent = attrs.text;
  if (attrs.title) el.title = attrs.title;
  if (attrs.id) el.id = attrs.id;
  if (attrs.style) el.setAttribute('style', attrs.style);
  if (attrs.type) el.setAttribute('type', attrs.type);
  if (attrs.placeholder !== undefined) el.setAttribute('placeholder', attrs.placeholder);
  if (attrs.min !== undefined) el.setAttribute('min', String(attrs.min));
  if (attrs.max !== undefined) el.setAttribute('max', String(attrs.max));
  if (attrs.step !== undefined) el.setAttribute('step', String(attrs.step));
  if (attrs.attrs) for (const [k, v] of Object.entries(attrs.attrs)) el.setAttribute(k, v);
  if (attrs.value !== undefined) {
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || el instanceof HTMLOptionElement || el instanceof HTMLButtonElement) {
      el.value = String(attrs.value);
    } else {
      el.setAttribute('value', String(attrs.value));
    }
  }
  if (attrs.disabled !== undefined && 'disabled' in el) (el as HTMLButtonElement).disabled = attrs.disabled;
  if (attrs.checked !== undefined && el instanceof HTMLInputElement) el.checked = attrs.checked;
  if (attrs.selected !== undefined && el instanceof HTMLOptionElement) el.selected = attrs.selected;
  const target: HTMLElement = el;
  if (attrs.onClick) target.addEventListener('click', attrs.onClick);
  if (attrs.onInput) target.addEventListener('input', attrs.onInput);
  if (attrs.onChange) target.addEventListener('change', attrs.onChange);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** A labelled value line: label on the left, value on the right. */
export function kv(label: Child, value: Child, cls = ''): HTMLElement {
  return h('div', { class: `kv ${cls}`.trim() }, h('span', { class: 'kv-label' }, label), h('span', { class: 'kv-value' }, value));
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: title }), ...children);
}

export function note(text: string, cls = ''): HTMLElement {
  return h('p', { class: `note ${cls}`.trim(), text });
}

/**
 * An action button that is disabled, with its reason as a small caption, when the
 * verdict fails (DESIGN.md 13: "disabled with a reason").
 */
export function verdictButton(label: Child, verdict: Verdict, onClick: () => void, cls = 'btn'): HTMLElement {
  const btn = h('button', {
    class: `${cls}${verdict.ok ? '' : ' is-disabled'}`,
    type: 'button',
    disabled: !verdict.ok,
    onClick: () => {
      if (verdict.ok) onClick();
    },
  }, label);
  if (verdict.ok) return btn;
  return h('div', { class: 'vwrap' }, btn, h('div', { class: 'vreason', text: verdict.reason ?? 'Not available right now.' }));
}

/** Five dots for skill 1..5; half-filled for the .5 steps. */
export function skillDots(skill: number): HTMLElement {
  const wrap = h('span', { class: 'dots', title: `Skill ${skillText(skill)}` });
  for (let i = 0; i < 5; i++) {
    const fill = skill - i;
    wrap.appendChild(h('i', { class: `dot${fill >= 0.75 ? ' full' : fill >= 0.25 ? ' half' : ''}` }));
  }
  wrap.appendChild(h('span', { class: 'dots-num', text: skillText(skill) }));
  return wrap;
}

/** A two-or-more option segmented control. */
export function segmented<T extends string>(options: { id: T; label: string; disabled?: boolean; title?: string }[], active: T, onPick: (id: T) => void): HTMLElement {
  return h('div', { class: 'seg' }, ...options.map((o) =>
    h('button', {
      class: `seg-btn${o.id === active ? ' active' : ''}`,
      type: 'button',
      text: o.label,
      title: o.title,
      disabled: o.disabled,
      onClick: () => {
        if (o.id !== active) onPick(o.id);
      },
    })));
}

/** Morale 0..100 as a bar. */
export function moraleBar(morale: number): HTMLElement {
  const v = Math.max(0, Math.min(100, Math.round(morale)));
  const tone = v < 20 ? 'bad' : v < 45 ? 'warn' : 'good';
  return h('span', { class: `morale ${tone}`, title: `Morale ${v}` },
    h('span', { class: 'morale-track' }, h('span', { class: 'morale-fill', style: `width:${v}%` })),
    h('span', { class: 'morale-num', text: String(v) }));
}

/** Two-step confirm: the first tap reveals the real button and a cancel. */
export function confirmButton(label: Child, question: string, confirmLabel: string, onConfirm: () => void, cls = 'btn danger'): HTMLElement {
  const wrap = h('div', { class: 'confirm' });
  const arm = h('button', { class: cls, type: 'button', onClick: () => { wrap.replaceChildren(armed); } }, label);
  const armed = h('div', { class: 'confirm-armed' },
    h('p', { class: 'note', text: question }),
    h('div', { class: 'btn-row' },
      h('button', { class: cls, type: 'button', text: confirmLabel, onClick: onConfirm }),
      h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onClick: () => { wrap.replaceChildren(arm); } })));
  wrap.appendChild(arm);
  return wrap;
}
