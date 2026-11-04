/**
 * The Playbook (DESIGN.md 18): the scaling sequence, the nine coach texts (the tour of
 * tutorial.ts shows them one stop at a time over the real screen; the Playbook page shows
 * them all at once, from "How to play" on the start screen and "?" during the round) and
 * the three bars explained. Every number in every sentence is generated from CONFIG/RULES
 * here, in one place, so the words can never drift from the game (DESIGN.md 15).
 *
 * PLAYBOOK names the coach's rules of thumb the texts quote (CONFIG.coach, the numbers the
 * advisor plays by); styleOnce is the small style injection the v2 screens use for the class
 * names the stylesheet does not yet know.
 */
import { CONFIG, RULES } from '../sim';
import { clock, days, money, percent, plural } from './format';
import { h } from './panels/dom';

const D = CONFIG.time.daysPerMonth;

/**
 * DESIGN.md 18, the coach's rules of thumb the texts quote, read from CONFIG.coach (DESIGN.md
 * 15: every number a player reads comes from config): the customer count that calls for the
 * first support agent, the months of cover a hire needs, the bank balance that pays for the
 * demo room and a second engineer, the investors taken before declining. The advisor and the
 * scripted tPlayer of the balance harness play the same numbers.
 */
export const PLAYBOOK = {
  /** DESIGN.md 18 rule 5: "Customers ≥ 10 and no support agent" */
  supportFromCustomers: CONFIG.coach.supportCustomers,
  /** DESIGN.md 18 rule 3: "cash covers 3 months of the new run-rate" */
  hireCoverMonths: CONFIG.coach.coverMonths,
  /** DESIGN.md 18 rules 8 and 9: "Cash > $100k" */
  richCash: CONFIG.coach.growthCash,
  /** DESIGN.md 18, the sequence: "After the second investor, decline" */
  knocksTaken: CONFIG.coach.knocksTaken,
} as const;

export interface PlaybookSection {
  /** a stable key: the tour pairs each of the nine coach sections with the control it points at */
  id: string;
  title: string;
  paragraphs: string[];
}

// ---------------------------------------------------------------- the numbers

/** DESIGN.md 6: output = skill × (base + morale ÷ divisor), at the starting morale (a hire comes with desk and laptop). */
function outputAt(skill: number): number {
  const p = CONFIG.people;
  return skill * (p.outputMoraleBase + p.morale.start / p.outputMoraleDivisor);
}

/** DESIGN.md 8: SMB conversion at n features with an empty market (saturation 1, no competitor). */
function conversionAt(features: number): number {
  return CONFIG.product.conversionMax * (1 - Math.exp(-CONFIG.product.conversionK * features));
}

/** The derived numbers the texts quote; exported so a test can check the words against them. */
export function coachNumbers() {
  const founderOutput = outputAt(CONFIG.start.founderSkill);
  const engineerOutput = outputAt(RULES.hire.product.skill);
  const marketerOutput = outputAt(RULES.hire.marketing.skill);
  const repOutput = outputAt(RULES.hire.sales.skill);
  const agentOutput = outputAt(RULES.hire.support.skill);
  const c = CONFIG.customers;
  const dealsPerMonth = c.dealsPerRepOutput * repOutput;
  const dayMs = (RULES.secondsPerMonth * 1000) / D;
  const roundMs = RULES.roundSeconds * 1000;
  return {
    minutes: Math.round(RULES.roundSeconds / 60),
    /** days to the first feature with the founder alone (DESIGN.md 8: cost 3 points at the founder's output) */
    firstFeatureDays: (CONFIG.product.featureBaseCost / founderOutput) * D,
    /** how much faster features ship with one engineer beside the founder */
    enginePace: (founderOutput + engineerOutput) / founderOutput,
    conversionAtHint: conversionAt(CONFIG.ui.marketingHintFeatures),
    conversionAtCap: conversionAt(CONFIG.product.priceFeatureCap),
    visitorsPerMarketer: CONFIG.marketing.visitorsPerOutput * marketerOutput,
    oneIn: Math.round(1 / c.enterpriseShare),
    dealDays: D / dealsPerMonth,
    /** customers one support agent keeps served (DESIGN.md 8: 15 tickets per output, 0.3 tickets per customer) */
    customersPerAgent: (c.ticketsPerAgentOutput * agentOutput) / c.ticketsPerCustomerPerMonth,
    churnUnserved: c.churnBase + c.churnUnserved,
    serverMonthly: CONFIG.assets.catalogue.server.price / CONFIG.assets.catalogue.server.lifeMonths,
    firstKnockMonths: [Math.ceil(CONFIG.capital.firstKnockDay[0] / D), Math.ceil(CONFIG.capital.firstKnockDay[1] / D)] as const,
    /** the countdown when the first knock can land: the round minus the wall-clock the knock day takes */
    firstKnockClock: [clock(roundMs - CONFIG.capital.firstKnockDay[0] * dayMs), clock(roundMs - CONFIG.capital.firstKnockDay[1] * dayMs)] as const,
    knockEveryMonths: [Math.round(CONFIG.capital.knockEveryDays[0] / D), Math.round(CONFIG.capital.knockEveryDays[1] / D)] as const,
  };
}

function ordinal(n: number): string {
  const words = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth'];
  return words[n] ?? `${n}th`;
}

/** "about 5 weeks" / "about 3 weeks" from days. */
function aboutWeeks(d: number): string {
  const w = Math.max(1, Math.round(d / 7));
  return `about ${plural(w, 'week')}`;
}

/** "twice as fast" when the pace is 2, else "2.5× as fast". */
function paceWord(x: number): string {
  if (Math.abs(x - 2) < 0.05) return 'twice as fast';
  if (Math.abs(x - 3) < 0.05) return 'three times as fast';
  return `${(Math.round(x * 10) / 10).toString()}× as fast`;
}

/** Round a count to its nearest ten for an "about" sentence. */
function aboutTen(n: number): number {
  return Math.max(10, Math.round(n / 10) * 10);
}

// ---------------------------------------------------------------- the texts

/**
 * The nine coach texts of DESIGN.md 18, in tour order, numbers from CONFIG/RULES. The tour
 * shows them over the screen; the Playbook page lists them as sections.
 */
export function coachSections(): PlaybookSection[] {
  const n = coachNumbers();
  const a = CONFIG.assets;
  const c = CONFIG.customers;
  const e = CONFIG.events;
  const k = CONFIG.capital;
  const pct = (x: number): string => percent(x);
  const rooms = CONFIG.rooms.size[RULES.roomSize];
  return [
    {
      id: 'goal',
      title: 'Goal and clock',
      paragraphs: [
        `${plural(n.minutes, 'minute')}. Score = company value × the share you still own when the buzzer sells the company. Cards stop the game, not the clock.`,
      ],
    },
    {
      id: 'pills',
      title: 'The pills',
      paragraphs: [
        'Cash pays salaries and ends the game below zero. Profit counts invoices you have not been paid yet. Cash flow is what really moved. Your stake is your score.',
      ],
    },
    {
      id: 'product',
      title: 'Product',
      paragraphs: [
        `Engineers ship features. Your first lands in ${aboutWeeks(n.firstFeatureDays)} on your own; an engineer beside you ships ${paceWord(n.enginePace)}. Every feature raises the share of visitors who buy (${pct(n.conversionAtHint)} at ${CONFIG.ui.marketingHintFeatures} features, ${pct(n.conversionAtCap)} at ${CONFIG.product.priceFeatureCap}) and the price ${pct(CONFIG.product.pricePerFeature)}. Nothing else works until the first feature exists.`,
      ],
    },
    {
      id: 'marketing',
      title: 'Marketing',
      paragraphs: [
        `Marketers bring people to the door. With nobody in Marketing about ${CONFIG.marketing.baseVisitorsPerMonth} visitors a month wander in; each marketer adds about ${Math.round(n.visitorsPerMarketer)}. Visitors only become customers if you have features, so marketing before your first feature is wasted money.`,
        `Each small customer pays ${money(c.smbPrice)} a month, plus ${pct(CONFIG.product.pricePerFeature)} per feature. Hire your first marketer when the hint says visitors are a trickle (around ${CONFIG.ui.marketingHintFeatures} features); a second once Profit shows the first one pays for itself. More customers means more tickets and more servers, so Support and a server follow.`,
      ],
    },
    {
      id: 'sales',
      title: 'Sales',
      paragraphs: [
        `About one visitor in ${n.oneIn} is a company, not a person. Companies wait in the lobby for a sales rep; with no rep they give up after ${days(c.prospectWaitDays)}. A rep works one deal at a time, about ${days(Math.round(n.dealDays))} each, and closes roughly ${pct(c.closeProb)} of them. A deal is a yearly contract worth ${money(c.enterpriseDeal)} plus ${pct(CONFIG.product.pricePerFeature)} per feature (${pct(a.demoRoomMult - 1)} more with a demo room).`,
        `The whole contract counts as profit the day it is signed, but the cash arrives ${days(CONFIG.finance.terms)} later: that is the tray at reception and the reason Profit and Cash flow disagree. Hire a rep the moment a prospect is waiting and you can cover ${plural(PLAYBOOK.hireCoverMonths, 'month')} of their pay; a second when prospects queue. A rep with no prospects is pure cost.`,
      ],
    },
    {
      id: 'support',
      title: 'Support',
      paragraphs: [
        `Customers raise tickets. With nobody answering, ${pct(n.churnUnserved)} of them leave every month; one agent keeps that at ${pct(c.churnBase)} up to about ${aboutTen(n.customersPerAgent)} customers. Hire from about ${PLAYBOOK.supportFromCustomers} customers.`,
      ],
    },
    {
      id: 'assets',
      title: 'Servers and demo room',
      paragraphs: [
        `One server per ${a.customersPerServer} customers. Each missing server is a ${pct(a.outageChancePerMissingServer)} chance per month of an outage that loses ${pct(a.outageChurn)} of your customers. ${money(a.catalogue.server.price)} leaves the bank now; profit only sees ${money(n.serverMonthly)} a month of it.`,
        `The demo room: ${money(a.catalogue.demoRoom.price)} once, enterprise deals ${pct(a.demoRoomMult - 1)} bigger. Worth it when a rep is closing.`,
      ],
    },
    {
      id: 'cards',
      title: 'Investors and events',
      paragraphs: [
        `Cash now for a slice forever. The first offer comes in month ${n.firstKnockMonths[0]} to ${n.firstKnockMonths[1]} (between ${n.firstKnockClock[0]} and ${n.firstKnockClock[1]} on the countdown), then one every ${n.knockEveryMonths[0]} to ${n.knockEveryMonths[1]} months. The first prices your team and your cash, because the business is not worth anything yet: a round can take up to ${pct(k.maxShareSold)} of the company; later offers are sized at ${pct(k.offerValueShare)} of what the business is worth. Take money you can spend inside the round; decline the rest. If the bank runs dry a lifeline comes with ${pct(k.desperationHaircut)} knocked off the price. No offers in the last ${plural(RULES.lastKnockDays, 'game day')}.`,
        `Late payer: press them if you need the cash (paid in ${days(e.pressPayDays)}, a ${pct(e.pressNoRenew)} chance they will not renew); waiting pushes the money out ${days(e.latePayerDelayDays)} with a ${pct(e.latePayerDefault)} chance it never comes. Press coverage: pay ${money(e.prPush)} for the push if you have features to sell (visitors ×${e.prMult} instead of ×${e.pressMult} for ${days(e.pressDays)}). Outage: pay the ${money(e.outageFix)} fix when the ${pct(e.outageLoss)} of customers at stake are worth more than that.`,
      ],
    },
    {
      id: 'strip',
      title: 'The strip and firing',
      paragraphs: [
        `Everyone is ranked by what the buzzer would pay them now. Firing costs ${plural(CONFIG.people.severanceMonths, 'month')}' pay; an emptied room closes itself (its desks sell at ${pct(a.resaleOfBook)} of book and the ${money(rooms.rent)} a month of rent stops).`,
      ],
    },
  ];
}

/** DESIGN.md 18: the scaling sequence, one step per paragraph. */
export function sequenceSection(): PlaybookSection {
  const n = coachNumbers();
  return {
    id: 'sequence',
    title: 'The scaling sequence',
    paragraphs: [
      'The first move: an engineer, at once.',
      `When the first investor knocks (between ${n.firstKnockClock[0]} and ${n.firstKnockClock[1]} on the countdown): take the money.`,
      'When the hint says visitors are a trickle: a marketer.',
      'When a prospect is waiting in the lobby: a sales rep.',
      `At ${PLAYBOOK.supportFromCustomers} customers: a support agent.`,
      `At ${CONFIG.assets.customersPerServer} customers: a server.`,
      `With more than ${money(PLAYBOOK.richCash)} in the bank: the demo room and a second engineer, then a second marketer.`,
      `After the ${ordinal(PLAYBOOK.knocksTaken)} investor, decline unless you can spend the money before the buzzer.`,
      'Answer every card at once: it stops your game, not the clock.',
      'Watch three things: the hint line, the lobby, and the strip.',
    ],
  };
}

/** DESIGN.md 9 in words: Profit, Free cash flow, Cash, and why they disagree. */
export function barsSection(): PlaybookSection {
  const server = CONFIG.assets.catalogue.server;
  const n = coachNumbers();
  return {
    id: 'bars',
    title: 'The three bars',
    paragraphs: [
      `Profit is the accountant's view. A yearly contract counts in full the day it is signed; a ${money(server.price)} server counts ${money(n.serverMonthly)} a month over ${server.lifeMonths / 12} years; an invoice you give up on is a loss the day you write it off.`,
      `Cash flow is what really moved this month. The contract's cash lands ${days(CONFIG.finance.terms)} after signing, the server's ${money(server.price)} leaves at once, and severance (${plural(CONFIG.people.severanceMonths, 'month')}' pay) leaves the day you let someone go.`,
      'Cash is the bank balance: cash flow plus what investors put in. Below zero at a month end, one lifeline knocks; decline it and the game is over, scoring 0.',
      'The why line under the pills names the biggest gap between Profit and Cash flow every month; Books, one tap on any pill, has the whole bridge.',
    ],
  };
}

/** The Playbook page: the sequence, the nine coach texts, the three bars. */
export function playbookSections(): PlaybookSection[] {
  return [sequenceSection(), ...coachSections(), barsSection()];
}

// ---------------------------------------------------------------- styles

/**
 * Appends a <style> with the given id once per document: the class names the v2 screens
 * need that the stylesheet (another module's) does not carry yet. Safe to call before any
 * DOM is drawn; a no-op outside a browser.
 */
export function styleOnce(id: string, css: string): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

const PLAYBOOK_CSS = `
.playbook { position: absolute; inset: 0; z-index: 15; display: flex; flex-direction: column; background: var(--paper, #f5f2ec); color: var(--ink, #22242b); }
.playbook-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px var(--gutter, 16px) 6px; }
.playbook-title { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
.playbook-sub { font-size: 12px; color: var(--ink-3, #9094a0); padding: 0 var(--gutter, 16px) 8px; }
.playbook-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 var(--gutter, 16px) 28px; display: flex; flex-direction: column; gap: 16px; overscroll-behavior: contain; }
.pb-sec { display: flex; flex-direction: column; gap: 6px; }
.pb-sec h3 { font-size: 12.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2, #5d616c); }
.pb-sec p { font-size: 13.5px; line-height: 1.42; }
.pb-sec.sequence p { padding-left: 10px; border-left: 3px solid var(--product, #5b8def); }
`;

export interface PlaybookHandle {
  close(): void;
}

export interface PlaybookOptions {
  /** fires once, after the sheet closed (the close button, Escape, or close()) */
  onClose?: () => void;
}

/** Opens the Playbook as a full-column sheet over root; the clock keeps running (DESIGN.md 0). */
export function openPlaybook(root: HTMLElement, opts: PlaybookOptions = {}): PlaybookHandle {
  styleOnce('sv-playbook-style', PLAYBOOK_CSS);
  let open = true;
  const body = h('div', { class: 'playbook-body' });
  for (const s of playbookSections()) {
    body.appendChild(h('section', { class: `pb-sec ${s.id}` },
      h('h3', { text: s.title }),
      ...s.paragraphs.map((p) => h('p', { text: p }))));
  }
  const sheet = h('div', { class: 'playbook', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How to play' } },
    h('div', { class: 'playbook-head' },
      h('h2', { class: 'playbook-title', text: 'How to play' }),
      h('button', { class: 'icon-btn', type: 'button', text: '×', title: 'Close', attrs: { 'aria-label': 'Close' }, onClick: () => close() })),
    h('p', { class: 'playbook-sub', text: 'The clock keeps running while this page is open.' }),
    body);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKey);
  root.appendChild(sheet);

  function close(): void {
    if (!open) return;
    open = false;
    window.removeEventListener('keydown', onKey);
    sheet.remove();
    opts.onClose?.();
  }

  return { close };
}
