/**
 * Hire sheet: Candidates (3 per role, grouped) and Team (rows with role, skill,
 * salary, morale, raises, fire). DESIGN.md sections 6 and 13.
 */
import { CONFIG, ROLES, ROLE_JOB, ROLE_LABEL, selectors } from '../../sim';
import type { Archetype, Candidate, GameState, Person, Quirk } from '../../sim';
import type { ShellController } from '../controller';
import { money } from '../format';
import { h, moraleBar, note, section, segmented, skillDots, verdictButton } from './dom';
import type { SheetSpec } from './sheet';

const ARCHETYPE_LABEL: Record<Archetype, string> = { junior: 'Junior', mid: 'Mid-level', senior: 'Senior', star: 'Star' };

/** Quirks in words, with the numbers taken from CONFIG so the caption never drifts from the rule. */
function quirkText(q: Quirk): string {
  const m = CONFIG.people.morale;
  switch (q) {
    case 'coffee': return `Needs a coffee machine (${m.coffeeQuirkNoMachine} morale without one)`;
    case 'crowd': return `Hates a full room (${m.crowdQuirkAtCapacity} morale at capacity)`;
    case 'mentor': return `Mentor: juniors in the same room learn ${CONFIG.people.mentorMult}× faster`;
    case 'mercenary': return `Mercenary: quits when morale drops below ${m.mercenaryQuitBelow}`;
    case 'loyal': return 'Loyal: never quits';
    case 'diva': return `Diva: asks for a raise every ${CONFIG.people.divaRaiseEveryMonths} months`;
  }
}

function candidateCard(controller: ShellController, c: Candidate): HTMLElement {
  const verdict = controller.can({ type: 'hire', candidateId: c.id });
  return h('div', { class: 'card-row cand' },
    h('div', { class: 'row-head' },
      h('b', { text: c.name }),
      h('span', { class: `tag ${c.archetype}`, text: ARCHETYPE_LABEL[c.archetype] })),
    h('div', { class: 'row-sub' }, ROLE_JOB[c.role], ' · ', skillDots(c.skill)),
    h('div', { class: 'row-sub' }, h('b', { text: `${money(c.salary)}/mo` })),
    h('div', { class: 'row-quirk', text: quirkText(c.quirk) }),
    h('div', { class: 'row-pitch', text: `“${c.pitch}”` }),
    verdictButton('Hire', verdict, () => controller.dispatch({ type: 'hire', candidateId: c.id }), 'btn primary'));
}

function candidatesTab(body: HTMLElement, state: GameState, controller: ShellController): void {
  body.appendChild(note(`Three candidates per role, refreshed every month end. A hire needs a free desk in that department's room (or the garage, ${CONFIG.rooms.garage.maxDesks} seats) and a month's salary in cash.`));
  for (const role of ROLES) {
    const list = state.candidates[role] ?? [];
    const roomNote = selectors.hasRoom(state, role) ? '' : ' · no room yet';
    const sec = section(`${ROLE_LABEL[role]} · ${ROLE_JOB[role]}s${roomNote}`);
    if (list.length === 0) sec.appendChild(note('Nobody on the market right now.', 'muted'));
    for (const c of list) sec.appendChild(candidateCard(controller, c));
    body.appendChild(sec);
  }
}

function personRow(controller: ShellController, state: GameState, p: Person): HTMLElement {
  const role = selectors.roleOf(state, p);
  const salary = selectors.salaryOf(state, p);
  const el = h('div', { class: 'card-row person' },
    h('div', { class: 'row-head' },
      h('b', { text: p.name }),
      h('span', { class: `tag ${p.founder ? 'founder' : p.archetype}`, text: p.founder ? 'Founder' : ARCHETYPE_LABEL[p.archetype] })));

  if (p.founder) {
    el.appendChild(h('div', { class: 'row-sub' },
      'Works as ',
      segmented(
        [
          { id: 'product', label: 'Product', title: 'Engineer', disabled: !controller.can({ type: 'founderRole', role: 'product' }).ok && state.founderRole !== 'product' },
          { id: 'sales', label: 'Sales', title: 'Sales rep', disabled: !controller.can({ type: 'founderRole', role: 'sales' }).ok && state.founderRole !== 'sales' },
        ],
        state.founderRole,
        (r) => controller.dispatch({ type: 'founderRole', role: r }),
      )));
  } else {
    el.appendChild(h('div', { class: 'row-sub' }, `${ROLE_LABEL[role]} · ${ROLE_JOB[role]}`));
  }

  el.appendChild(h('div', { class: 'row-sub' }, skillDots(p.skill), ' · ', h('b', { text: p.founder ? 'no salary' : `${money(salary)}/mo` }),
    p.founder ? null : (salary < p.baseSalary ? h('span', { class: 'muted', text: ` (cut from ${money(p.baseSalary)})` }) : null),
    p.hasLaptop ? null : h('span', { class: 'warn-text', text: ' · no laptop' })));
  el.appendChild(h('div', { class: 'row-sub' }, 'Morale ', moraleBar(p.morale), h('span', { class: 'muted', text: ` · ${quirkText(p.quirk)}` })));

  if (p.raisePending) {
    const newSalary = p.baseSalary * (1 + CONFIG.people.raisePct);
    const v = controller.can({ type: 'raise', personId: p.id, grant: true });
    el.appendChild(h('div', { class: 'raise' },
      h('div', { class: 'raise-text', text: `Asks for a raise to ${money(newSalary)}/mo (+${Math.round(CONFIG.people.raisePct * 100)}%). Refusing costs morale for ${CONFIG.people.morale.raiseRefusedMonths} months.` }),
      h('div', { class: 'btn-row' },
        verdictButton(`Grant · ${money(newSalary)}/mo`, v, () => controller.dispatch({ type: 'raise', personId: p.id, grant: true }), 'btn primary small'),
        verdictButton('Refuse', v, () => controller.dispatch({ type: 'raise', personId: p.id, grant: false }), 'btn ghost small'))));
  }

  if (!p.founder) {
    const severance = selectors.severanceOf(state, p);
    const v = controller.can({ type: 'fire', personId: p.id });
    el.appendChild(h('div', { class: 'btn-row' },
      verdictButton(`Fire · ${money(severance)} severance`, v, () => controller.dispatch({ type: 'fire', personId: p.id }), 'btn danger small')));
  }
  return el;
}

function teamTab(body: HTMLElement, state: GameState, controller: ShellController): void {
  const salaries = selectors.monthlySalaries(state);
  body.appendChild(note(`${state.people.length} people · payroll ${money(salaries)}/mo · severance is ${CONFIG.people.severanceMonths} months' salary.`));
  const people = [...state.people].sort((a, b) => (b.founder ? 1 : 0) - (a.founder ? 1 : 0) || ROLES.indexOf(selectors.roleOf(state, a)) - ROLES.indexOf(selectors.roleOf(state, b)));
  for (const p of people) body.appendChild(personRow(controller, state, p));
}

export function hireSheet(controller: ShellController): SheetSpec {
  return {
    id: 'hire',
    title: 'Hire',
    tabs: [{ id: 'candidates', label: 'Candidates' }, { id: 'team', label: 'Team' }],
    render(body, state, tab) {
      if (tab === 'team') teamTab(body, state, controller);
      else candidatesTab(body, state, controller);
    },
  };
}

export { quirkText, ARCHETYPE_LABEL };
