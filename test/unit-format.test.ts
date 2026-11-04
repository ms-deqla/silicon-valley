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
