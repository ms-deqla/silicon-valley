/**
 * Investor knocks, equity rounds, loans, maturity, prepayment. DESIGN.md section 10.
 * Every dollar here moves through ledger.ts; every random pick through state.rng.
 */
import type { Card, CardChoice, GameState, Verdict } from './types';
import { no, OK } from './types';
import { CONFIG } from './config';
import { pick, randInt } from './rng';
import * as L from './ledger';
import * as S from './selectors';
import { gameOver } from './exit';
import { fmtMoney, fmtPct, fmtRate } from './hints';

const D = CONFIG.time.daysPerMonth;

/** Cosmetic: who knocks and what they say. Picked with state.rng so a run replays identically. */
const INVESTORS: readonly { fund: string; quote: string }[] = [
  { fund: 'Horizon Ventures', quote: 'We like what we see. Let us talk terms.' },
  { fund: 'Lighthouse Capital', quote: 'Every company needs a war chest. Here is ours.' },
  { fund: 'Blue Fjord Partners', quote: 'We back builders early. You look like one.' },
  { fund: 'Summit Ridge Ventures', quote: 'Growth costs money. We have money.' },
  { fund: 'Northwind Growth', quote: 'We have watched your numbers for a while. We want in.' },
  { fund: 'Quartz Lane Capital', quote: 'Take the money while it is on offer.' },
  { fund: 'Ember & Oak', quote: 'Good founders raise before they have to.' },
  { fund: 'Tidewater Ventures', quote: 'Our term sheet is simple. Our patience is not infinite.' },
];

const DESPERATION_QUOTES: readonly string[] = [
  'We hear the bank balance is thin. We can fix that, on our terms.',
  'Nobody else is calling, are they? Here is what we can do.',
  'Distress is a pricing event. This is the price.',
  'You need cash this month. We need half the company.',
];

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------- daily

/** Daily: loan maturity (card 'maturity'), desperation knock when runway < 2 months (cooldown), scheduled knock. */
export function dailyCapital(state: GameState): void {
  if (state.status !== 'playing') return;
  if (!state.card) checkMaturity(state);
  if (!state.card) checkDesperation(state);
  if (!state.card && state.day >= state.schedule.nextKnockDay) openKnock(state, false);
}

/**
 * DESIGN.md 10: principal due in one payment on the due day. Paid in full when the
 * cash is there; otherwise the bank offers one rollover (12 months at +3%), after
 * which refusing or failing is game over.
 */
function checkMaturity(state: GameState): void {
  const loan = state.loan;
  if (!loan || state.day < loan.dueDay) return;
  const C = CONFIG.capital;
  if (state.cash >= loan.principal) {
    L.recordLoanRepaid(state, loan.principal);
    state.loan = null;
    state.log.push({ day: state.day, text: `Loan repaid: ${fmtMoney(loan.principal)} went back to the bank.`, tone: 'info' });
    state.visuals.push({ t: 'toast', day: state.day, text: `Loan repaid: ${fmtMoney(loan.principal)}`, tone: 'info' });
    return;
  }
  const newRate = loan.annualRate + C.rolloverPremium;
  const rollover: CardChoice = {
    id: 'rollover',
    label: 'Roll it over',
    detail: `${C.rolloverMonths} more months at ${fmtRate(newRate)} a year`,
  };
  if (loan.rolledOver) {
    rollover.disabled = true;
    rollover.reason = 'The bank already rolled this loan over once';
  }
  const offer = loan.rolledOver
    ? 'The bank will not extend it again.'
    : `The bank offers one rollover: ${C.rolloverMonths} more months at ${fmtRate(newRate)} a year.`;
  state.card = {
    id: `card${state.nextId++}`,
    kind: 'maturity',
    title: 'The loan is due',
    speaker: 'Your bank manager',
    quote: loan.rolledOver ? 'We extended once. We do not extend twice.' : 'We can give you a little more time. It will cost you.',
    body: `Your ${fmtMoney(loan.principal)} loan came due today and there is ${fmtMoney(state.cash)} in the bank. ${offer}`,
    choices: [rollover, { id: 'default', label: 'Default', detail: 'The bank calls it in: game over' }],
    data: { principal: loan.principal },
    createdDay: state.day,
  };
  state.log.push({ day: state.day, text: `The ${fmtMoney(loan.principal)} loan is due and the cash is not there.`, tone: 'bad' });
}

/** DESIGN.md 10: desperation knock when runway < 2 months, at most once per 60 days. */
function checkDesperation(state: GameState): void {
  const C = CONFIG.capital;
  const runway = S.runwayMonths(state);
  if (runway === null || runway >= C.desperationRunwayMonths) return;
  if (state.day - state.schedule.lastDesperationDay < C.desperationCooldownDays) return;
  openKnock(state, true);
}

// ---------------------------------------------------------------- knocks

/**
 * Build and open a knock card (kind 'knock' or 'desperation'): amount, equity terms, loan terms, decline.
 * Loan choice disabled (with reason) without a Finance room or with a loan outstanding.
 * Returns null if a card is already open.
 */
export function openKnock(state: GameState, desperate: boolean): Card | null {
  if (state.card) return null;
  const C = CONFIG.capital;
  const base = CONFIG.valuation.base;
  const val = state.valuation;
  const value = Math.max(0, val.value);

  // DESIGN.md 10: offer = max(6 × burn, 15% of OPERATING value), min $50k; if profitable max(15% of operating, $100k);
  // rounded to $10k. Operating value excludes the acqui-hire floor so hiring cannot pump the next offer.
  const operating = Math.max(0, val.operating);
  const burn = S.monthlyBurn(state);
  const raw = burn > 0
    ? Math.max(C.offerBurnMonths * burn, C.offerValueShare * operating, C.offerMin)
    : Math.max(C.offerValueShare * operating, C.offerMinProfitable);

  // DESIGN.md 10: haircut = 0.10 + 0.25 × riskIndex (0.5 when desperate); pre-money = value × (1 − haircut)
  const riskIndex = clamp((val.r - base) / C.riskSpan, 0, 1);
  const haircut = desperate ? C.desperationHaircut : C.haircutBase + C.haircutRisk * riskIndex;
  const preMoney = Math.max(value * (1 - haircut), 1);

  // DESIGN.md 10: never more than maxShareSold of the company in one round
  const maxAmount = preMoney * C.maxShareSold / (1 - C.maxShareSold);
  const amount = Math.max(C.offerRound, Math.round(Math.min(raw, maxAmount) / C.offerRound) * C.offerRound);
  const share = amount / (preMoney + amount);

  // DESIGN.md 10: loan rate = 0.04 + (r − 0.12) / 2
  const loanRate = C.loanBaseRate + (val.r - base) * C.loanRiskShare;

  const voice = pick(state.rng, INVESTORS);
  const quote = desperate ? pick(state.rng, DESPERATION_QUOTES) : voice.quote;

  const equity: CardChoice = { id: 'equity', label: 'Take equity', detail: `${fmtMoney(amount)} for ${fmtPct(share)}` };
  const loan: CardChoice = {
    id: 'loan',
    label: 'Take a loan',
    detail: `${fmtMoney(amount)} at ${fmtRate(loanRate)} a year, due in ${C.loanTermMonths} months`,
  };
  if (!S.hasRoom(state, 'finance')) {
    loan.disabled = true;
    loan.reason = 'Open a Finance room to borrow';
  } else if (state.loan) {
    loan.disabled = true;
    loan.reason = 'One loan at a time';
  }
  const decline: CardChoice = { id: 'decline', label: 'Not now', detail: 'Costs nothing' };

  const body = desperate
    ? `Word is out that ${state.companyName} is short of cash. ${voice.fund} will put in ${fmtMoney(amount)} for ${fmtPct(share)} of the company, `
      + `a ${fmtPct(haircut)} haircut on your ${fmtMoney(value)} value. A loan at ${fmtRate(loanRate)} a year is the other way out.`
    : `${voice.fund} values ${state.companyName} at ${fmtMoney(preMoney)} before the money. They would put in ${fmtMoney(amount)} `
      + `for ${fmtPct(share)} of the company, or lend it at ${fmtRate(loanRate)} a year. Investors want ${fmtRate(val.r)} from a company like yours.`;

  const card: Card = {
    id: `card${state.nextId++}`,
    kind: desperate ? 'desperation' : 'knock',
    title: desperate ? 'A lifeline, at a price' : 'An investor knocks',
    speaker: `A partner at ${voice.fund}`,
    quote,
    body,
    choices: [equity, loan, decline],
    data: { amount, share, preMoney, loanRate, fund: voice.fund },
    createdDay: state.day,
  };
  state.card = card;

  // DESIGN.md 10: the next knock comes [120, 240] days after this one, whatever kind it was
  state.schedule.nextKnockDay = state.day + randInt(state.rng, C.knockEveryDays[0], C.knockEveryDays[1]);
  if (desperate) state.schedule.lastDesperationDay = state.day;

  state.log.push({
    day: state.day,
    text: desperate
      ? `${voice.fund} offers a lifeline: ${fmtMoney(amount)} for ${fmtPct(share)}.`
      : `${voice.fund} knocks: ${fmtMoney(amount)} for ${fmtPct(share)}, or a loan at ${fmtRate(loanRate)}.`,
    tone: desperate ? 'bad' : 'info',
  });
  return card;
}

// ---------------------------------------------------------------- resolving cards

/** Apply the chosen option of a knock / desperation / maturity card; clear state.card. */
export function resolveCapitalCard(state: GameState, card: Card, choiceId: string): void {
  const choice = card.choices.find((c) => c.id === choiceId);
  if (choice && !choice.disabled) {
    if (card.kind === 'maturity') resolveMaturity(state, choiceId);
    else resolveKnock(state, card, choiceId);
  }
  state.card = null;
}

function resolveKnock(state: GameState, card: Card, choiceId: string): void {
  const C = CONFIG.capital;
  const amount = num(card.data.amount);
  const share = num(card.data.share);
  const preMoney = num(card.data.preMoney);
  const loanRate = num(card.data.loanRate);
  const fund = str(card.data.fund) || 'The investor';
  switch (choiceId) {
    case 'equity': {
      // DESIGN.md 10: founder share multiplies by (1 − share sold); cash lands instantly
      L.recordEquity(state, amount);
      state.founderShare *= 1 - share;
      state.rounds.push({
        day: state.day,
        amount,
        shareSold: share,
        preMoney,
        postMoney: preMoney + amount,
        desperate: card.kind === 'desperation',
      });
      const text = `${fund} invested ${fmtMoney(amount)} for ${fmtPct(share)}. You now own ${fmtPct(state.founderShare)}.`;
      state.log.push({ day: state.day, text, tone: 'good' });
      state.visuals.push({ t: 'toast', day: state.day, text: `${fund} invested ${fmtMoney(amount)} for ${fmtPct(share)}`, tone: 'good' });
      break;
    }
    case 'loan': {
      // DESIGN.md 10: interest accrues daily (game.ts accrual via selectors.monthlyInterest); principal due in 36 months
      L.recordLoanIn(state, amount);
      state.loan = {
        id: `loan${state.nextId++}`,
        principal: amount,
        annualRate: loanRate,
        startDay: state.day,
        dueDay: state.day + C.loanTermMonths * D,
        rolledOver: false,
      };
      state.log.push({
        day: state.day,
        text: `Borrowed ${fmtMoney(amount)} at ${fmtRate(loanRate)} a year, due on day ${state.loan.dueDay}.`,
        tone: 'info',
      });
      break;
    }
    case 'decline':
      // DESIGN.md 10: declining a knock costs nothing
      state.log.push({ day: state.day, text: `You passed on ${fund}.`, tone: 'info' });
      break;
    default:
      break;
  }
}

function resolveMaturity(state: GameState, choiceId: string): void {
  const C = CONFIG.capital;
  const loan = state.loan;
  switch (choiceId) {
    case 'rollover': {
      if (!loan) return;
      // DESIGN.md 10: one rollover for 12 months at +3%
      loan.dueDay += C.rolloverMonths * D;
      loan.annualRate += C.rolloverPremium;
      loan.rolledOver = true;
      state.log.push({
        day: state.day,
        text: `The bank rolled the ${fmtMoney(loan.principal)} loan over: now ${fmtRate(loan.annualRate)} a year, due on day ${loan.dueDay}.`,
        tone: 'info',
      });
      break;
    }
    case 'default':
      // DESIGN.md 10: refusing or failing the rollover is game over
      gameOver(state, 'The loan came due and could not be paid.');
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- prepayment

/** DESIGN.md 10: prepay any time, no penalty, as long as the cash covers the principal. */
export function canPrepay(state: GameState): Verdict {
  if (!state.loan) return no('No loan outstanding.');
  if (state.cash < state.loan.principal) return no(`Repaying needs ${fmtMoney(state.loan.principal)} in cash.`);
  return OK;
}

/** ledger.recordLoanRepaid(principal); loan = null. */
export function prepayLoan(state: GameState): void {
  const loan = state.loan;
  if (!loan) return;
  L.recordLoanRepaid(state, loan.principal);
  state.loan = null;
  state.log.push({ day: state.day, text: `Loan prepaid: ${fmtMoney(loan.principal)} went back to the bank early.`, tone: 'good' });
}
