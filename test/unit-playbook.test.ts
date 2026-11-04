/**
 * The Playbook and the tour texts (DESIGN.md 18): every number a player reads is generated
 * from CONFIG/RULES, so the words are checked against the config, never against literals
 * retyped here. Pure functions; nothing touches the DOM.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, RULES } from '../src/sim';
import { clock, days, money, percent, plural } from '../src/ui/format';
import { PLAYBOOK, barsSection, coachNumbers, coachSections, playbookSections, sequenceSection } from '../src/ui/playbook';
import { tourStops } from '../src/ui/tutorial';
import { useTournamentRules } from './setup';

const D = CONFIG.time.daysPerMonth;

function text(sections: { paragraphs: string[] }[]): string {
  return sections.map((s) => s.paragraphs.join(' ')).join('\n');
}

describe('the Playbook (DESIGN.md 18)', () => {
  beforeEach(() => {
    useTournamentRules();
  });

  it('is the sequence, the nine decision sections and the three bars', () => {
    const sections = playbookSections();
    expect(sections).toHaveLength(11);
    expect(sections[0].id).toBe('sequence');
    expect(sections[sections.length - 1].id).toBe('bars');
    expect(sections.slice(1, 10).map((s) => s.id)).toEqual(['goal', 'pills', 'product', 'marketing', 'sales', 'support', 'assets', 'cards', 'strip']);
    for (const s of sections) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.paragraphs.length).toBeGreaterThan(0);
      for (const p of s.paragraphs) expect(p.length).toBeGreaterThan(10);
    }
  });

  it('the derived numbers follow the config (DESIGN.md 6 and 8)', () => {
    const n = coachNumbers();
    const p = CONFIG.people;
    const founderOut = CONFIG.start.founderSkill * (p.outputMoraleBase + p.morale.start / p.outputMoraleDivisor);
    expect(n.firstFeatureDays).toBeCloseTo((CONFIG.product.featureBaseCost / founderOut) * D, 6);
    expect(n.enginePace).toBeCloseTo(2, 6);
    expect(n.conversionAtHint).toBeCloseTo(CONFIG.product.conversionMax * (1 - Math.exp(-CONFIG.product.conversionK * CONFIG.ui.marketingHintFeatures)), 9);
    expect(n.visitorsPerMarketer).toBeCloseTo(CONFIG.marketing.visitorsPerOutput * RULES.hire.marketing.skill * (p.outputMoraleBase + p.morale.start / p.outputMoraleDivisor), 6);
    expect(n.oneIn).toBe(Math.round(1 / CONFIG.customers.enterpriseShare));
    expect(n.churnUnserved).toBeCloseTo(CONFIG.customers.churnBase + CONFIG.customers.churnUnserved, 9);
    expect(n.serverMonthly).toBeCloseTo(CONFIG.assets.catalogue.server.price / CONFIG.assets.catalogue.server.lifeMonths, 6);
    expect(n.firstKnockMonths).toEqual([Math.ceil(CONFIG.capital.firstKnockDay[0] / D), Math.ceil(CONFIG.capital.firstKnockDay[1] / D)]);
    expect(n.minutes).toBe(RULES.roundSeconds / 60);
  });

  it('the nine sections quote the config numbers', () => {
    const all = text(coachSections());
    const n = coachNumbers();
    const c = CONFIG.customers;
    const a = CONFIG.assets;
    const e = CONFIG.events;
    const k = CONFIG.capital;
    const expected = [
      plural(Math.round(RULES.roundSeconds / 60), 'minute'),
      `${plural(Math.round(n.firstFeatureDays / 7), 'week')}`,
      `${percent(n.conversionAtHint)} at ${CONFIG.ui.marketingHintFeatures} features`,
      `${percent(n.conversionAtCap)} at ${CONFIG.product.priceFeatureCap}`,
      `the price ${percent(CONFIG.product.pricePerFeature)}`,
      `about ${CONFIG.marketing.baseVisitorsPerMonth} visitors a month`,
      `each marketer adds about ${Math.round(n.visitorsPerMarketer)}`,
      `${money(c.smbPrice)} a month`,
      `around ${CONFIG.ui.marketingHintFeatures} features`,
      `one visitor in ${n.oneIn}`,
      `give up after ${days(c.prospectWaitDays)}`,
      `closes roughly ${percent(c.closeProb)}`,
      `worth ${money(c.enterpriseDeal)}`,
      `${percent(a.demoRoomMult - 1)} more with a demo room`,
      `cash arrives ${days(CONFIG.finance.terms)} later`,
      `cover ${plural(PLAYBOOK.hireCoverMonths, 'month')} of their pay`,
      `${percent(n.churnUnserved)} of them leave every month`,
      `keeps that at ${percent(c.churnBase)}`,
      `Hire from about ${PLAYBOOK.supportFromCustomers} customers`,
      `One server per ${a.customersPerServer} customers`,
      `${percent(a.outageChancePerMissingServer)} chance per month`,
      `loses ${percent(a.outageChurn)} of your customers`,
      `${money(a.catalogue.server.price)} leaves the bank now`,
      `profit only sees ${money(n.serverMonthly)} a month`,
      `${money(a.catalogue.demoRoom.price)} once`,
      `month ${n.firstKnockMonths[0]} to ${n.firstKnockMonths[1]}`,
      `between ${n.firstKnockClock[0]} and ${n.firstKnockClock[1]} on the countdown`,
      `up to ${percent(k.maxShareSold)} of the company`,
      `sized at ${percent(k.offerValueShare)}`,
      `${percent(k.desperationHaircut)} knocked off`,
      `last ${plural(RULES.lastKnockDays, 'game day')}`,
      `paid in ${days(e.pressPayDays)}`,
      `pay ${money(e.prPush)} for the push`,
      `the ${money(e.outageFix)} fix`,
      `Firing costs ${plural(CONFIG.people.severanceMonths, 'month')}' pay`,
      `${percent(a.resaleOfBook)} of book`,
    ];
    for (const s of expected) expect(all).toContain(s);
    // the first knock window on the countdown counts down from the round (DESIGN.md 0)
    const dayMs = (RULES.secondsPerMonth * 1000) / D;
    expect(n.firstKnockClock[0]).toBe(clock(RULES.roundSeconds * 1000 - k.firstKnockDay[0] * dayMs));
  });

  it('the sequence and the bars quote the config too', () => {
    const seq = text([sequenceSection()]);
    expect(seq).toContain(`At ${PLAYBOOK.supportFromCustomers} customers: a support agent.`);
    expect(seq).toContain(`At ${CONFIG.assets.customersPerServer} customers: a server.`);
    expect(seq).toContain(`With more than ${money(PLAYBOOK.richCash)} in the bank`);
    expect(seq).toContain('After the second investor');
    expect(seq).toContain('Answer every card at once');
    const bars = text([barsSection()]);
    expect(bars).toContain(money(CONFIG.assets.catalogue.server.price));
    expect(bars).toContain(days(CONFIG.finance.terms));
    expect(bars).toContain(`${CONFIG.assets.catalogue.server.lifeMonths / 12} years`);
  });

  it('never prints a bare NaN, undefined or Infinity', () => {
    const all = text(playbookSections());
    expect(all).not.toMatch(/NaN|undefined|Infinity|\[object/);
  });
});

describe('the tour (DESIGN.md 18)', () => {
  it('has nine stops in the Playbook order, each with the section text and a target to point at', () => {
    const stops = tourStops();
    const sections = coachSections();
    expect(stops).toHaveLength(9);
    expect(stops.map((s) => s.id)).toEqual(sections.map((s) => s.id));
    for (let i = 0; i < stops.length; i++) {
      expect(stops[i].title).toBe(sections[i].title);
      expect(stops[i].text).toBe(sections[i].paragraphs.join(' '));
      expect(stops[i].targets.length).toBeGreaterThan(0);
      expect(stops[i].targets[0]).toMatch(/^\[data-tour=/);
    }
    expect(stops.find((s) => s.id === 'product')?.targets).toContain('.board-row.product');
    expect(stops.find((s) => s.id === 'strip')?.targets).toContain('[data-tour="strip"]');
  });
});
