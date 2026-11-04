/**
 * The control board at the bottom of the column (DESIGN.md 0): one row per department
 * in RULES.roles — headcount, monthly cost, − (let the most recent hire go) and + (hire
 * one fixed person at the salary shown, with any setup cost or new-room rent as a
 * caption) — then the two assets: servers and the demo room. Built once and patched on
 * every state change; a disabled button keeps taking taps so it can say why (the sim's
 * reason, as a toast).
 */
import { CONFIG, ROLE_JOB, ROLE_LABEL, RULES, headcount, roomRentForHire, selectors, setupCost } from '../../sim';
import type { Action, GameState, Person, Role, Verdict } from '../../sim';
import type { ShellController } from '../controller';
import { money, plural } from '../format';
import { h } from './dom';
import type { Child } from './dom';

export interface Board {
  el: HTMLElement;
  /** Patch every row from state; called on state change only. */
  update(state: GameState): void;
}

const GLYPH: Record<Role, string> = { product: '🛠', sales: '🤝', support: '🎧', marketing: '📣', finance: '💼', rnd: '🔬' };

interface Gate {
  verdict: Verdict;
  action: Action;
}

interface GatedButton {
  el: HTMLButtonElement;
  set(gate: Gate): void;
}

/**
 * A board button. It is never natively disabled: a refused action keeps its tap so the
 * sim's reason can be toasted (DESIGN.md 13: "disabled with a reason").
 */
function gatedButton(controller: ShellController, cls: string, ariaLabel: string, ...content: Child[]): GatedButton {
  let gate: Gate | null = null;
  const el = h('button', {
    class: `board-btn ${cls}`,
    type: 'button',
    attrs: { 'aria-label': ariaLabel },
    onClick: () => {
      if (!gate) return;
      if (gate.verdict.ok) controller.dispatch(gate.action);
      else controller.toast(gate.verdict.reason ?? 'Not available right now.', 'bad');
    },
  }, ...content);
  return {
    el,
    set(next) {
      gate = next;
      el.classList.toggle('is-disabled', !next.verdict.ok);
      el.setAttribute('aria-disabled', next.verdict.ok ? 'false' : 'true');
    },
  };
}

/** The person fireRole would let go: the most recent hire in the department (same order as tournament.ts). */
function lastHire(state: GameState, role: Role): Person | null {
  let best: Person | null = null;
  for (const p of state.people) {
    if (p.founder || p.role !== role) continue;
    if (!best || p.hiredDay > best.hiredDay || (p.hiredDay === best.hiredDay && p.id > best.id)) best = p;
  }
  return best;
}

function jobWord(role: Role): string {
  return ROLE_JOB[role].toLowerCase();
}

/** "an engineer", "a sales rep". */
function aJob(role: Role): string {
  const word = jobWord(role);
  return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
}

interface Row {
  el: HTMLElement;
  update(state: GameState): void;
}

function deptRow(controller: ShellController, role: Role): Row {
  const spec = RULES.hire[role];
  const meta = h('span', { class: 'board-meta' });
  const minus = gatedButton(controller, 'minus', `Let the newest ${jobWord(role)} go`, '−');
  const cap = h('small', { class: 'board-cap' });
  const plus = gatedButton(controller, 'plus', `Hire ${aJob(role)} at ${money(spec.salary)} a month`,
    h('b', { text: `+ ${money(spec.salary)}/mo` }), cap);
  const el = h('div', { class: `board-row dept ${role}` },
    h('span', { class: `glyph ${role}`, text: GLYPH[role], attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'board-main' }, h('b', { class: 'board-name', text: ROLE_LABEL[role] }), meta),
    minus.el,
    plus.el);

  return {
    el,
    update(state) {
      const n = headcount(state, role);
      meta.textContent = `${plural(n, jobWord(role))} · ${money(n * spec.salary)}/mo`;

      const fire: Action = { type: 'fireRole', role };
      const fireV = controller.can(fire);
      minus.set({ verdict: fireV, action: fire });
      const last = lastHire(state, role);
      minus.el.title = last
        ? `Let ${last.name} go · ${money(selectors.severanceOf(state, last))} severance (${CONFIG.people.severanceMonths} months' salary)`
        : fireV.reason ?? 'Nobody to let go.';

      const hire: Action = { type: 'hireRole', role };
      const hireV = controller.can(hire);
      plus.set({ verdict: hireV, action: hire });
      const setup = setupCost(state, role);
      const rent = roomRentForHire(state, role);
      const extras: string[] = [];
      if (setup > 0) extras.push(`setup ${money(setup)}`);
      if (rent > 0) extras.push(`room ${money(rent)}/mo`);
      cap.textContent = extras.join(' · ');
      cap.hidden = extras.length === 0;
      plus.el.title = hireV.ok
        ? `Hire ${aJob(role)}: ${money(spec.salary)}/mo${extras.length ? `, plus ${extras.join(' and ')}` : ''}`
        : hireV.reason ?? 'Not available right now.';
    },
  };
}

export function createBoard(controller: ShellController): Board {
  const rows = RULES.roles.map((role) => deptRow(controller, role));

  const serverCfg = CONFIG.assets.catalogue.server;
  const demoCfg = CONFIG.assets.catalogue.demoRoom;
  const serversText = h('span', { class: 'asset-text' });
  const serverBtn = gatedButton(controller, 'buy', `Buy a server for ${money(serverCfg.price)}`,
    h('b', { text: 'Server' }), h('small', { class: 'board-cap', text: `Buy ${money(serverCfg.price)}` }));
  const demoCap = h('small', { class: 'board-cap', text: `Buy ${money(demoCfg.price)}` });
  const demoBtn = gatedButton(controller, 'buy', `Buy the demo room for ${money(demoCfg.price)}`,
    h('b', { text: 'Demo room' }), demoCap);
  const assets = h('div', { class: 'board-row assets' },
    h('span', { class: 'glyph assets', text: '🖥', attrs: { 'aria-hidden': 'true' } }),
    serversText,
    serverBtn.el,
    demoBtn.el);

  const el = h('div', { class: 'board', attrs: { 'aria-label': 'Control board' } }, ...rows.map((r) => r.el), assets);

  function update(state: GameState): void {
    for (const r of rows) r.update(state);

    const owned = selectors.serversOwned(state);
    const needed = selectors.serversNeeded(state);
    serversText.replaceChildren(h('b', { text: `Servers ${owned}` }), ` / ${needed} needed`);
    serversText.classList.toggle('short', owned < needed);
    serversText.title = `One server per ${CONFIG.assets.customersPerServer} customers (${state.customers.length} now). Each missing server risks an outage every month.`;
    const buyServer: Action = { type: 'buyAsset', kind: 'server' };
    serverBtn.set({ verdict: controller.can(buyServer), action: buyServer });

    const buyDemo: Action = { type: 'buyDemoRoom' };
    const demoV = controller.can(buyDemo);
    const built = selectors.hasDemoRoom(state);
    demoBtn.set({ verdict: demoV, action: buyDemo });
    demoCap.textContent = built ? 'Built' : `Buy ${money(demoCfg.price)}`;
    demoBtn.el.title = built
      ? `Built. Enterprise deals ×${CONFIG.assets.demoRoomMult}.`
      : demoV.ok ? `${money(demoCfg.price)} once, no rent. Enterprise deals ×${CONFIG.assets.demoRoomMult}.` : demoV.reason ?? '';
  }

  return { el, update };
}
