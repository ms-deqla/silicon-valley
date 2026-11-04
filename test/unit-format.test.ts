import { describe, expect, it } from 'vitest';
import { customerName, days, dueText, money, moneyFull, months, percent, signedMoney, skillText } from '../src/ui/format';
import { customerName as simCustomerName } from '../src/sim/events';

describe('format.money', () => {
  it('formats thousands and millions the HUD way', () => {
    expect(money(50_000)).toBe('$50k');
    expect(money(1_200_000)).toBe('$1.2M');
    expect(money(-6_000)).toBe('−$6k');
    expect(money(6_500)).toBe('$6.5k');
    expect(money(12_345_678)).toBe('$12M');
    expect(money(999_600)).toBe('$1M');
    expect(money(9_949)).toBe('$9.9k');
    expect(money(9_950)).toBe('$10k');
    expect(money(420)).toBe('$420');
    expect(money(0)).toBe('$0');
    expect(money(-0.2)).toBe('$0');
    expect(money(2_500_000_000)).toBe('$2.5B');
    expect(money(Number.NaN)).toBe('—');
  });

  it('signs and full forms', () => {
    expect(signedMoney(5_000)).toBe('+$5k');
    expect(signedMoney(-6_000)).toBe('−$6k');
    expect(signedMoney(0)).toBe('$0');
    expect(moneyFull(3_000)).toBe('$3,000');
    expect(moneyFull(-1_234_567)).toBe('−$1,234,567');
    expect(moneyFull(0)).toBe('$0');
  });
});

describe('format.percent / months / days', () => {
  it('percent', () => {
    expect(percent(0.24)).toBe('24%');
    expect(percent(0.1234, 1)).toBe('12.3%');
    expect(percent(-0.05)).toBe('−5%');
    expect(percent(-0.001)).toBe('0%');
  });
  it('months and days', () => {
    expect(months(1)).toBe('1 month');
    expect(months(7.5)).toBe('7.5 months');
    expect(months(12)).toBe('12 months');
    expect(days(1)).toBe('1 day');
    expect(days(30)).toBe('30 days');
  });
  it('due text', () => {
    expect(dueText(100, 88)).toBe('due in 12 days');
    expect(dueText(100, 100)).toBe('due today');
    expect(dueText(100, 103)).toBe('late by 3 days');
  });
  it('skill text', () => {
    expect(skillText(3.5)).toBe('3.5');
    expect(skillText(4)).toBe('4');
  });
  it('names a customer the way the sim\'s cards and log lines do, so the Books tray matches the late-payer card', () => {
    for (const id of ['c1', 'c12', 'c57', 'c123', 'c4096']) {
      expect(customerName(id)).toBe(customerName(id));
      expect(customerName(id)).toBe(simCustomerName(id));
    }
    expect(customerName('c12')).not.toMatch(/#/);
  });
});

// ---------------------------------------------------------------- the cap table and the stake (DESIGN.md 0 v2)
import { capTable, fundOfRound, initials, shareAtClose, stakeHistory } from '../src/ui/format';
import { createGame } from '../src/sim/game';
import { CONFIG } from '../src/sim/config';
import type { GameState, Round } from '../src/sim/types';

function round(day: number, shareSold: number, amount: number, desperate = false): Round {
  const preMoney = amount / shareSold - amount;
  return { day, amount, shareSold, preMoney, postMoney: preMoney + amount, desperate };
}

/** A state with two rounds and the log lines capital.ts writes when they close. */
function dilutedState(): GameState {
  const state = createGame(7);
  state.rounds.push(round(60, 0.2, 50_000), round(200, 0.1, 100_000));
  state.founderShare = 0.8 * 0.9;
  state.log.push({ day: 60, text: 'Horizon Ventures invested $50k for 20%. You now own 80%.', tone: 'good' });
  state.log.push({ day: 200, text: 'Ember & Oak invested $100k for 10%. You now own 72%.', tone: 'good' });
  return state;
}

describe('format.initials', () => {
  it('takes the first letter of each word, drops small words, keeps at most three', () => {
    expect(initials('Horizon Ventures')).toBe('HV');
    expect(initials('Ember & Oak')).toBe('EO');
    expect(initials('Blue Fjord Partners')).toBe('BFP');
    expect(initials('Summit Ridge Ventures Fund')).toBe('SRV');
    expect(initials('Round 2')).toBe('R2');
    expect(initials('')).toBe('?');
  });
});

describe('format.capTable', () => {
  it('starts with you alone', () => {
    const state = createGame(1);
    const table = capTable(state);
    expect(table).toHaveLength(1);
    expect(table[0].kind).toBe('you');
    expect(table[0].share).toBe(1);
  });

  it('dilutes every earlier slice by every later round, so the slices add up to one', () => {
    const state = dilutedState();
    const table = capTable(state);
    expect(table.map((e) => e.label)).toEqual(['You', 'Horizon Ventures', 'Ember & Oak']);
    expect(table.map((e) => e.initials)).toEqual(['You', 'HV', 'EO']);
    expect(table[0].share).toBeCloseTo(0.72, 10);
    expect(table[1].share).toBeCloseTo(0.2 * 0.9, 10);
    expect(table[2].share).toBeCloseTo(0.1, 10);
    expect(table.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 10);
    expect(table[1].number).toBe(1);
    expect(table[2].round?.amount).toBe(100_000);
  });

  it('names a round by its number when the log line is gone, and pairs same-day rounds in order', () => {
    const state = dilutedState();
    state.log = state.log.filter((e) => e.day !== 200);
    expect(fundOfRound(state, 1)).toBeNull();
    expect(capTable(state)[2].label).toBe('Round 2');
    expect(capTable(state)[2].initials).toBe('R2');
    // two rounds on one day: the k-th round takes the k-th line of that day
    state.rounds.push(round(200, 0.05, 20_000));
    state.log.push({ day: 200, text: 'Quartz Lane Capital invested $20k for 5%. You now own 68%.', tone: 'good' });
    expect(fundOfRound(state, 1)).toBe('Quartz Lane Capital');
    expect(fundOfRound(state, 2)).toBeNull();
  });
});

describe('format.shareAtClose / stakeHistory', () => {
  it('applies the rounds signed before the close, not one signed on the close day', () => {
    const state = dilutedState();
    expect(shareAtClose(state, 0)).toBe(1);
    expect(shareAtClose(state, 60)).toBe(1);
    expect(shareAtClose(state, 61)).toBeCloseTo(0.8, 10);
    expect(shareAtClose(state, 300)).toBeCloseTo(0.72, 10);
  });

  it('draws value × the share of the time, one point per entry of valueHistory', () => {
    const state = dilutedState();
    const D = CONFIG.time.daysPerMonth;
    // seven closes: valueHistory holds day 0 and the closes of months 0..6 (days 30..210)
    state.valueHistory = [100, 110, 120, 130, 140, 150, 160, 170];
    state.history = Array.from({ length: 7 }, (_, m) => ({ ...state.book, month: m, startDay: m * D, closed: true }));
    const stakes = stakeHistory(state);
    expect(stakes).toHaveLength(8);
    expect(stakes[0]).toBe(100);
    // the close of month 1 is day 60: the day-60 round is not in yet
    expect(stakes[2]).toBe(120);
    // the close of month 2 is day 90: the 20% round is in
    expect(stakes[3]).toBeCloseTo(130 * 0.8, 10);
    // day 210: both rounds are in
    expect(stakes[7]).toBeCloseTo(170 * 0.72, 10);
  });

  it('keeps the newest entries when valueHistory is capped', () => {
    const state = dilutedState();
    const D = CONFIG.time.daysPerMonth;
    // 19 closes, 12 kept: the oldest kept point is the close of month 7 (day 240), after both rounds
    const months = CONFIG.valuation.historyMonths + 7;
    state.history = Array.from({ length: months }, (_, m) => ({ ...state.book, month: m, startDay: m * D, closed: true }));
    state.valueHistory = Array.from({ length: CONFIG.valuation.historyMonths }, (_, i) => 1000 + i);
    const stakes = stakeHistory(state);
    expect(stakes).toHaveLength(CONFIG.valuation.historyMonths);
    for (let i = 0; i < stakes.length; i++) expect(stakes[i]).toBeCloseTo((1000 + i) * 0.72, 10);
    // negative values are floored at zero, like the HUD
    state.valueHistory[0] = -5;
    expect(stakeHistory(state)[0]).toBe(0);
  });
});
