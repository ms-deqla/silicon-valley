/**
 * Investor knocks, equity rounds, loans, maturity, prepayment. DESIGN.md section 10.
 * Every dollar here moves through ledger.ts; every random pick through state.rng.
 */
import type { Card, CardChoice, GameState, Loan, Verdict } from './types';
import { no, OK } from './types';
import { CONFIG, RULES } from './config';
import { pick, randInt } from './rng';
import * as L from './ledger';
import * as S from './selectors';
import { gameOver } from './exit';
import { computeValuation } from './valuation';
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

/** Both money choices carry this when the 40% cap leaves no $10k step to offer (DESIGN.md 10). */
const NOTHING_TO_RAISE = 'Nothing to raise against: the company is worth too little';

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
  if (!state.card && state.day >= state.schedule.nextKnockDay && !scheduledKnockBlackout(state)) openKnock(state, false);
}

/**
 * DESIGN.md 10: principal due in one payment on the due day. Paid in full when the
 * cash is there; otherwise the bank offers one rollover (12 months at +3%), after
 * which refusing or failing is game over.
 *
 * game.ts runs this check (tick step 8) before a close-day closeMonth (step 10), so on
 * a close day the month's SMB billing lands under the open card. The cash is therefore
 * tested again when the card is answered (resolveMaturity), and the card says so; on
 * any other day nothing can land under the card, so Repay is greyed out.
 */
function checkMaturity(state: GameState): void {
  const loan = state.loan;
  if (!loan || state.day < loan.dueDay) return;
  const C = CONFIG.capital;
  if (state.cash >= loan.principal) {
    repayAtMaturity(state, loan, `Loan repaid: ${fmtMoney(loan.principal)} went back to the bank.`);
    return;
  }
  const closing = state.day % D === 0;
  const newRate = loan.annualRate + C.rolloverPremium;
  const repay: CardChoice = {
    id: 'repay',
    label: 'Repay',
    detail: closing ? `Pay ${fmtMoney(loan.principal)} if this month's billing covers it` : `Pay ${fmtMoney(loan.principal)} now`,
  };
  if (!closing) {
    repay.disabled = true;
    repay.reason = `There is only ${fmtMoney(state.cash)} in the bank`;
  }
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
  const balance = closing
    ? `there is ${fmtMoney(state.cash)} in the bank before this month's subscriptions are billed; if they cover the principal, the loan is simply repaid`
    : `there is ${fmtMoney(state.cash)} in the bank`;
  state.card = {
    id: `card${state.nextId++}`,
    kind: 'maturity',
    title: 'The loan is due',
    speaker: 'Your bank manager',
    quote: loan.rolledOver ? 'We extended once. We do not extend twice.' : 'We can give you a little more time. It will cost you.',
    body: `Your ${fmtMoney(loan.principal)} loan came due today and ${balance}. ${offer}`,
    choices: [repay, rollover, { id: 'default', label: 'Default', detail: 'The bank calls it in: game over' }],
    data: { principal: loan.principal },
    createdDay: state.day,
  };
  state.log.push({
    day: state.day,
    text: `The ${fmtMoney(loan.principal)} loan is due and the cash is not there${closing ? ' before the month-end billing' : ''}.`,
    tone: 'bad',
  });
}

/** The principal goes back to the bank through the ledger and the loan is gone. */
function repayAtMaturity(state: GameState, loan: Loan, text: string): void {
  L.recordLoanRepaid(state, loan.principal);
  state.loan = null;
  state.log.push({ day: state.day, text, tone: 'info' });
  state.visuals.push({ t: 'toast', day: state.day, text: `Loan repaid: ${fmtMoney(loan.principal)}`, tone: 'info' });
}

/**
 * DESIGN.md 0: no scheduled knock in the last stretch of a round; money that arrives in the final
 * month cannot be used. The round ends when the shell says it does (schedule.roundEndDay: open
 * cards cost game months, so the buzzer rings before the nominal day), or on the nominal
 * RULES.roundMonths when nothing has projected the end (headless runs, replays). No round, no blackout.
 */
function scheduledKnockBlackout(state: GameState): boolean {
  const nominalEnd = RULES.roundMonths === null ? null : RULES.roundMonths * D;
  const endDay = state.schedule.roundEndDay ?? nominalEnd;
  if (endDay === null) return false;
  return endDay - state.day < RULES.lastKnockDays;
}

/** DESIGN.md 10: desperation knock when runway < 2 months, at most once per 60 days. */
function checkDesperation(state: GameState): void {
  const C = CONFIG.capital;
  // DESIGN.md 10: the lifeline comes only after investors have knocked once on their own schedule
  // (the crisis knock at a close with cash < 0 goes through game.solvencyCheck and is always available)
  if (state.schedule.knocks === 0) return;
  const runway = S.runwayMonths(state);
  if (runway === null || runway >= C.desperationRunwayMonths) return;
  if (state.day - state.schedule.lastDesperationDay < C.desperationCooldownDays) return;
  openKnock(state, true);
}

// ---------------------------------------------------------------- knocks

/**
 * Build and open a knock card (kind 'knock' or 'desperation'): amount, equity terms, loan terms, decline.
 * Loan choice disabled (with reason) without a Finance room or with a loan outstanding; both equity
 * and loan disabled when the 40% cap leaves nothing to offer (the card still opens, so the schedule
 * and the crisis flow in game.ts are untouched: declining it costs nothing).
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
  const preMoney = value * (1 - haircut);

  // DESIGN.md 10: rounded to $10k, and one round never sells more than maxShareSold of the company:
  // the amount is cut to fit. The cut is applied after rounding and rounded DOWN to the step (on whole
  // dollars, so float noise cannot drop a step), so share = amount / (pre-money + amount) stays at or
  // under the cap. When the pre-money cannot carry even one step, nothing is offered: a company with
  // no operations can only raise against its floor, and the minimum never overrides the cap.
  const maxAmount = preMoney * C.maxShareSold / (1 - C.maxShareSold);
  const rounded = Math.round(raw / C.offerRound) * C.offerRound;
  const capped = Math.floor(Math.round(maxAmount) / C.offerRound) * C.offerRound;
  const amount = Math.min(rounded, capped);
  const canRaise = amount >= C.offerRound;
  const share = canRaise ? amount / (preMoney + amount) : 0;

  // DESIGN.md 10: loan rate = 0.04 + (r − 0.12) / 2
  const loanRate = C.loanBaseRate + (val.r - base) * C.loanRiskShare;

  const voice = pick(state.rng, INVESTORS);
  const quote = desperate ? pick(state.rng, DESPERATION_QUOTES) : voice.quote;

  const equity: CardChoice = {
    id: 'equity',
    label: 'Take equity',
    detail: canRaise ? `${fmtMoney(amount)} for ${fmtPct(share)}` : 'No stake to sell',
  };
  const loan: CardChoice = {
    id: 'loan',
    label: 'Take a loan',
    detail: canRaise ? `${fmtMoney(amount)} at ${fmtRate(loanRate)} a year, due in ${C.loanTermMonths} months` : 'Nothing to lend against',
  };
  if (!canRaise) {
    equity.disabled = true;
    equity.reason = NOTHING_TO_RAISE;
    loan.disabled = true;
    loan.reason = NOTHING_TO_RAISE;
  } else if (!S.hasRoom(state, 'finance')) {
    loan.disabled = true;
    loan.reason = 'Open a Finance room to borrow';
  } else if (state.loan) {
    loan.disabled = true;
    loan.reason = 'One loan at a time';
  }
  const decline: CardChoice = { id: 'decline', label: 'Not now', detail: 'Costs nothing' };

  let body: string;
  if (!canRaise) {
    body = desperate
      ? `Word is out that ${state.companyName} is short of cash. ${voice.fund} looked at the books and found nothing to put money against: `
        + `after a ${fmtPct(haircut)} haircut on your ${fmtMoney(value)} value, not even ${fmtMoney(C.offerRound)} fits inside the ${fmtPct(C.maxShareSold)} `
        + `they may take in one round.`
      : `${voice.fund} values ${state.companyName} at ${fmtMoney(preMoney)} before the money: too little to put even ${fmtMoney(C.offerRound)} in `
        + `without taking more than ${fmtPct(C.maxShareSold)} of the company in one round. Investors want ${fmtRate(val.r)} from a company like yours.`;
  } else if (desperate) {
    // DESIGN.md 0: the loan is only on the table (and in the words) when the ruleset offers it
    body = `Word is out that ${state.companyName} is short of cash. ${voice.fund} will put in ${fmtMoney(amount)} for ${fmtPct(share)} of the company, `
      + `a ${fmtPct(haircut)} haircut on your ${fmtMoney(value)} value.`
      + (RULES.loans ? ` A loan at ${fmtRate(loanRate)} a year is the other way out.` : '');
  } else {
    body = `${voice.fund} values ${state.companyName} at ${fmtMoney(preMoney)} before the money. They would put in ${fmtMoney(amount)} `
      + `for ${fmtPct(share)} of the company${RULES.loans ? `, or lend it at ${fmtRate(loanRate)} a year` : ''}. Investors want ${fmtRate(val.r)} from a company like yours.`
      + (val.operating <= 0 ? ' The business itself is not worth anything yet: they are pricing your team and your cash.' : '');
  }

  const card: Card = {
    id: `card${state.nextId++}`,
    kind: desperate ? 'desperation' : 'knock',
    title: desperate ? 'A lifeline, at a price' : 'An investor knocks',
    speaker: `A partner at ${voice.fund}`,
    quote,
    body,
    choices: RULES.loans ? [equity, loan, decline] : [equity, decline],
    data: { amount, share, preMoney, loanRate, fund: voice.fund },
    createdDay: state.day,
  };
  state.card = card;

  // DESIGN.md 10: the next knock comes [120, 240] days after this one, whatever kind it was
  state.schedule.nextKnockDay = state.day + randInt(state.rng, C.knockEveryDays[0], C.knockEveryDays[1]);
  state.schedule.knocks += 1;
  if (desperate) state.schedule.lastDesperationDay = state.day;

  state.log.push({
    day: state.day,
    text: !canRaise
      ? `${voice.fund} ${desperate ? 'looked at the books' : 'knocks'}, but ${state.companyName} is worth too little to raise against.`
      : desperate
        ? `${voice.fund} offers a lifeline: ${fmtMoney(amount)} for ${fmtPct(share)}.`
        : `${voice.fund} knocks: ${fmtMoney(amount)} for ${fmtPct(share)}${RULES.loans ? `, or a loan at ${fmtRate(loanRate)}` : ''}.`,
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
      // the HUD and the next card price off the new cash and share at once, not at the next close
      state.valuation = computeValuation(state);
      state.rounds.push({
        day: state.day,
        amount,
        shareSold: share,
        preMoney,
        postMoney: preMoney + amount,
        desperate: card.kind === 'desperation',
              fund: str(card.data.fund),
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
  if (!loan) return;
  // DESIGN.md 10 keys the maturity on the cash, so it is tested again here, not only when the card
  // opened: on a close day the month-end SMB billing (game.ts step 10) landed under the open card.
  if (state.cash >= loan.principal) {
    repayAtMaturity(state, loan, `Loan repaid: the month-end billing covered the ${fmtMoney(loan.principal)}.`);
    return;
  }
  // A repayment the cash cannot cover gets the bank's answer: the one rollover, or the call.
  const tried = choiceId === 'repay';
  const outcome = tried ? (loan.rolledOver ? 'default' : 'rollover') : choiceId;
  switch (outcome) {
    case 'rollover': {
      // DESIGN.md 10: one rollover for 12 months at +3%
      loan.dueDay += C.rolloverMonths * D;
      loan.annualRate += C.rolloverPremium;
      loan.rolledOver = true;
      state.log.push({
        day: state.day,
        text: `${tried ? 'The billing did not cover it. ' : ''}The bank rolled the ${fmtMoney(loan.principal)} loan over: `
          + `now ${fmtRate(loan.annualRate)} a year, due on day ${loan.dueDay}.`,
        tone: 'info',
      });
      break;
    }
    case 'default':
      // DESIGN.md 10: refusing or failing the rollover is game over
      gameOver(state, tried ? 'The loan came due and the month-end billing did not cover it.' : 'The loan came due and could not be paid.');
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
