/**
 * Every tuning number in the game, named and commented. Nothing in src/sim may
 * hard-code a number that appears here. DESIGN.md sections 5–12 are the prose form.
 */
import type { Archetype, AssetKind, EventType, Role, RoomSize } from './types';

export const CONFIG = {
  time: {
    daysPerMonth: 30,
  },

  start: {
    cash: 50_000,
    founderSkill: 3,
    founderName: 'You',
    companyName: 'BrightByte',
  },

  grid: {
    w: 6,
    h: 8,
    garage: { x: 0, y: 6, w: 2, h: 2 },
    lobby: { x: 2, y: 6, w: 2, h: 2 },
  },

  rooms: {
    /** department rooms by size */
    size: {
      small: { w: 2, h: 2, maxDesks: 4, rent: 3_000 },
      large: { w: 3, h: 2, maxDesks: 6, rent: 4_500 },
    } as Record<RoomSize, { w: number; h: number; maxDesks: number; rent: number }>,
    garage: { maxDesks: 2, rent: 0 },
    lobby: { maxDesks: 0, rent: 0 },
    demo: { w: 2, h: 2, maxDesks: 0, rent: 0 },
  },

  assets: {
    catalogue: {
      desk: { price: 1_000, lifeMonths: 60, label: 'Desk' },
      laptop: { price: 2_000, lifeMonths: 36, label: 'Laptop' },
      server: { price: 20_000, lifeMonths: 48, label: 'Server' },
      coffee: { price: 5_000, lifeMonths: 60, label: 'Coffee machine' },
      demoRoom: { price: 40_000, lifeMonths: 120, label: 'Demo room' },
      secondFloor: { price: 60_000, lifeMonths: 240, label: 'Second floor' },
    } as Record<AssetKind, { price: number; lifeMonths: number; label: string }>,
    /** resale = this × book value; the rest is a disposal loss */
    resaleOfBook: 0.6,
    /** servers: one per this many customers; needed = floor(customers ÷ this), so the first is due at 50 */
    customersPerServer: 50,
    /** monthly chance of an outage per missing server (rolled at close) */
    outageChancePerMissingServer: 0.10,
    /** share of customers lost in an outage */
    outageChurn: 0.15,
    /** morale bonus for everyone when a coffee machine exists */
    coffeeMorale: 10,
    /** enterprise deal multiplier with a demo room */
    demoRoomMult: 1.3,
  },

  people: {
    salaries: { junior: 4_000, mid: 7_000, senior: 11_000, star: 14_000 } as Record<Archetype, number>,
    /** ± this share of noise on candidate salaries */
    salaryNoise: 0.10,
    skill: { junior: [1, 2], mid: [2.5, 3.5], senior: [4, 5], star: [5, 5] } as Record<Archetype, [number, number]>,
    /** archetype weights for candidate generation */
    archetypeWeights: { junior: 4, mid: 3, senior: 2, star: 1 } as Record<Archetype, number>,
    candidatesPerRole: 3,
    juniorLearnPerMonth: 0.1,
    juniorLearnCap: 3,
    /** juniors in a room with a mentor learn this much faster */
    mentorMult: 2,
    severanceMonths: 3,
    raisePct: 0.15,
    raiseEveryMonths: 12,
    /** divas and stars ask this often */
    divaRaiseEveryMonths: 6,
    /** a pending raise unanswered for this many days counts as refused */
    raisePendingDays: 60,
    /** star reps take this share of enterprise deals, in cash at signing */
    starCommission: 0.10,
    /** output multiplier without a laptop */
    noLaptopOutput: 0.5,
    /** output = skill × (outputMoraleBase + morale ÷ outputMoraleDivisor) (DESIGN.md 6) */
    outputMoraleBase: 0.5,
    outputMoraleDivisor: 200,
    /** salaries and raises are rounded to this */
    salaryRound: 100,
    morale: {
      start: 70,
      base: 70,
      noDeskOrLaptop: -25,
      crowded: -10,
      overload: -15,
      raiseGranted: 15,
      raiseGrantedMonths: 3,
      raiseRefused: -30,
      raiseRefusedMonths: 6,
      coffeeQuirkNoMachine: -15,
      crowdQuirkAtCapacity: -20,
      /** below this a person may quit */
      quitBelow: 20,
      quitChancePerMonth: 0.10,
      mercenaryQuitBelow: 35,
      /** morale moves this share of the gap toward its target each day */
      driftPerDay: 0.1,
      /** raise ask triggered early below this morale */
      askRaiseBelow: 40,
    },
  },

  product: {
    /** feature cost in points = base + perFeature × features shipped */
    featureBaseCost: 3,
    featureCostPerFeature: 1,
    /** price multiplier per feature */
    pricePerFeature: 0.10,
    /** features beyond this no longer raise the price (they still raise conversion) */
    priceFeatureCap: 10,
    /** smb conversion = max × (1 − e^(−k × features)) */
    conversionK: 0.15,
    conversionMax: 0.5,
  },

  rnd: {
    tier2Points: 60,
    tier3Points: 150,
    /** index by tier */
    tierMult: [1, 1, 1.5, 2.25],
  },

  marketing: {
    /** the first marketer turns the base trickle into ~3.6× the traffic (6 → 6 + 6 × 2.55): a strong move, not the whole game */
    baseVisitorsPerMonth: 6,
    visitorsPerOutput: 6,
    /** visitors += this × sqrt(ad budget in $k) */
    adVisitorsPerSqrtK: 2,
    adMax: 20_000,
    adStep: 1_000,
  },

  customers: {
    /** the market is finite: conversion and close rate scale by marketSize ÷ (marketSize + customers) */
    marketSize: 150,
    enterpriseShare: 0.15,
    smbPrice: 300,
    enterpriseDeal: 30_000,
    /** an enterprise prospect waits this long in the lobby */
    prospectWaitDays: 45,
    /** a rep closes output × this many deals per month of attention */
    dealsPerRepOutput: 0.5,
    closeProb: 0.5,
    enterpriseContractMonths: 12,
    /** enterprise renews when served share ≥ this */
    renewServedMin: 0.5,
    ticketsPerCustomerPerMonth: 0.3,
    ticketsPerAgentOutput: 15,
    /** monthly smb churn = base + unserved × share of tickets unserved */
    churnBase: 0.02,
    churnUnserved: 0.06,
  },

  finance: {
    /** invoice terms in days */
    terms: 90,
    termsPerSkill: 5,
    termsFloor: 30,
    /** default chance on late payers is halved with finance staff */
    defaultHalving: 0.5,
  },

  valuation: {
    /** required return r (annual) = base + the five premia below (DESIGN.md 10) */
    base: 0.12,
    /** burn premium = burnMax × clamp(1 − runway ÷ burnRunwayMonths, 0, 1) while the FCF run-rate is negative */
    burnMax: 0.15,
    burnRunwayMonths: 12,
    /** R&D premium = (R&D salaries ÷ total monthly costs) × this */
    rndMax: 0.10,
    /** leverage premium = debt ÷ (debt + last month's value) × this */
    leverageMax: 0.08,
    /** concentration premium = largest customer's share of annualised revenue × this */
    concentrationMax: 0.05,
    /** added to r while a recession is active */
    recession: 0.05,
    /** months of monthly flows the DCF projects before the terminal value */
    horizonMonths: 60,
    /** trusted trailing growth per month is clamped to [growthMin, growthMax] (lumpy enterprise bookings must not collapse the DCF) */
    growthMin: -0.04,
    growthMax: 0.04,
    /** trailing growth is measured over this many closed months (shorter while history is short) */
    growthWindowMonths: 6,
    /** growth compares averages over this many closed months at both ends of the window (lumpy bookings) */
    growthSmoothMonths: 3,
    /** no growth estimate from a window shorter than this */
    growthMinLagMonths: 2,
    /** trailing growth is trusted in proportion to last month's revenue ÷ this (tiny bases do not forecast) */
    growthTrustRevenue: 20_000, // trailing growth is trusted in proportion to the recent 3-month average revenue ÷ this
    /** growth decays linearly from g0 to this annual rate (the terminal growth) over growthDecayMonths */
    terminalGrowthAnnual: 0.02,
    growthDecayMonths: 12,
    /** terminal value is at most this many years of the horizon flow */
    terminalMaxYears: 5,
    /** the DCF base is the average operating cash flow (after maintenance capex) of the last this many closed months: a year catches every annual enterprise invoice exactly once, so the value does not swing on collection timing */
    runRateMonths: 12,
    /** floor = cash + arRecovery × open receivables + assetRecovery × assets at book − debt + acqui-hire value */
    arRecovery: 0.9,
    assetRecovery: 0.6,
    /** acqui-hire value = Σ skill × this over everyone, founder included */
    acquihirePerSkill: 50_000,
    /** a hire counts toward the acqui-hire value only after this many days (acquirers pay for teams that have worked together); the founder always counts */
    acquihireVestDays: 90,
    /** the acqui-hire part of the floor never exceeds this */
    acquihireCap: 1_000_000,
    /** months of company value kept in state.valueHistory: the HUD's 12-month sparkline (DESIGN.md 10) */
    historyMonths: 12,
  },

  capital: {
    /** the first investor knock lands on a random day in this range (before the early rep hire runs the cash out), then one every knockEveryDays after any knock */
    firstKnockDay: [45, 120] as [number, number],
    knockEveryDays: [120, 240] as [number, number],
    /** a desperation knock opens when runway < this many months, at most once per desperationCooldownDays */
    desperationRunwayMonths: 2,
    desperationCooldownDays: 60,
    /** offer = max(offerBurnMonths × burn, offerValueShare × operating value, offerMin); if profitable, max(offerValueShare × operating, offerMinProfitable) */
    offerBurnMonths: 6,
    offerValueShare: 0.15,
    offerMin: 50_000,
    offerMinProfitable: 100_000,
    /** offers are rounded to this */
    offerRound: 10_000,
    /** equity haircut = haircutBase + haircutRisk × riskIndex, riskIndex = clamp((r − base) ÷ riskSpan, 0, 1) */
    haircutBase: 0.10,
    haircutRisk: 0.25,
    /** r − base spans this range for riskIndex 0..1 */
    riskSpan: 0.43,
    /** haircut on a desperation knock */
    desperationHaircut: 0.5,
    /** an offer never asks for more than this share of the company in one round */
    maxShareSold: 0.4,
    /** loan annual rate = loanBaseRate + (r − base) × loanRiskShare; principal due in one payment after loanTermMonths */
    loanBaseRate: 0.04,
    loanRiskShare: 0.5,
    loanTermMonths: 36,
    /** the one rollover at maturity: rolloverMonths more at +rolloverPremium */
    rolloverMonths: 12,
    rolloverPremium: 0.03,
  },

  events: {
    /** the first event card lands on a random day in this range (none before day 180), then one every everyDays (two to five months: under one per three months, DESIGN.md 16) */
    firstDay: [180, 270] as [number, number],
    everyDays: [60, 150] as [number, number],
    /** late payer: "Wait" pushes the due date out latePayerDelayDays with latePayerDefault chance of a write-off (halved with finance staff) */
    latePayerDelayDays: 60,
    latePayerDefault: 0.15,
    /** late payer: "Press them" is paid in pressPayDays with pressNoRenew chance that customer will not renew */
    pressPayDays: 10,
    pressNoRenew: 0.5,
    /** outage: the emergency fix costs outageFix; riding it out loses outageLoss of the customers */
    outageFix: 15_000,
    outageLoss: 0.15,
    /** press: a PR push costs prPush and multiplies visitors by prMult, "Enjoy it" by pressMult, for pressDays */
    prPush: 10_000,
    prMult: 3,
    pressMult: 2,
    pressDays: 30,
    /** competitor: conversion × competitorMult until competitorFeatures more features ship, or all prices × priceCut for priceCutDays */
    competitorMult: 0.75,
    competitorFeatures: 2,
    priceCut: 0.85,
    priceCutDays: 180,
    /** poach: the counter-offer raises the salary by this share */
    counterOffer: 0.30,
    /** recession: visitors × recessionVisitors for recessionDays; "Tighten" cuts salaries by tightenCut and morale by tightenMorale */
    recessionVisitors: 0.6,
    recessionDays: 180,
    tightenCut: 0.10,
    tightenMorale: -20,
    /** outage event weight multiplier when servers are short */
    outageShortWeight: 4,
    /** an event needs a company of this size (customers) before it can fire */
    minCustomers: { latePayer: 0, outage: 20, press: 0, competitor: 5, poach: 0, recession: 10 } as Record<EventType, number>,
    /** relative draw weights of the six events once eligible (the late payer is the most common story) */
    weights: { latePayer: 2, outage: 1, press: 1, competitor: 1, poach: 1, recession: 1 } as Record<EventType, number>,
  },

  exit: {
    sellFromDay: 720,
  },

  ui: {
    maxWalkers: 12,
    logLength: 200,
    /** at most this many churn figures walk out per day; the Books counters carry the real number */
    maxChurnVisualsPerDay: 3,
    /** why line: a cash-bridge item below this is not worth a sentence */
    whyMinItem: 1_000,
    /** hint line: "Runway: X months" below this many months */
    lowRunwayMonths: 3,
    /** hint line: "Open Marketing" from this many features */
    marketingHintFeatures: 3,
    /** hint line: "Support is swamped" below this served share */
    supportHintServed: 0.8,
  },
} as const;

export type Config = typeof CONFIG;

/**
 * The tournament ruleset (DESIGN.md 0): which engine mechanics reach the player.
 * Mutable on purpose so engine tests can switch a mechanic back on; the game never
 * writes to it.
 */
export interface Rules {
  /** departments the player can hire into; the others exist in the engine only */
  roles: Role[];
  /** one fixed hire per department: no candidates, no quirks, no salary noise */
  hire: Record<Role, { archetype: Archetype; skill: number; salary: number }>;
  raises: boolean;
  quits: boolean;
  loans: boolean;
  finance: boolean;
  rnd: boolean;
  adBudget: boolean;
  /** the founder can be moved between Product and Sales (DESIGN.md 6); off in the tournament, which has no such control */
  founderRole: boolean;
  /** selling the company before the buzzer (DESIGN.md 12); off in the tournament, where only the buzzer sells */
  sell: boolean;
  /** events that can fire */
  events: EventType[];
  /** the round: wall-clock seconds per game month, and per round */
  secondsPerMonth: number;
  roundSeconds: number;
  /** game months in a round, or null when there is no round (the full engine) */
  roundMonths: number | null;
  /** size of the rooms ensureSeat opens */
  roomSize: RoomSize;
  /** a department room closes itself when its last person leaves (desks sold at resale, rent stops) */
  autoCloseRooms: boolean;
  /** ensureSeat buys the second floor by itself when the ground floor is full */
  upstairs: boolean;
  /** no scheduled investor knock opens when fewer than this many game days remain in the round (lifelines still do) */
  lastKnockDays: number;
}

export const RULES: Rules = {
  roles: ['product', 'sales', 'support', 'marketing'],
  hire: {
    product: { archetype: 'mid', skill: 3, salary: 5_000 },
    sales: { archetype: 'mid', skill: 3, salary: 4_000 },
    support: { archetype: 'mid', skill: 3, salary: 3_000 },
    marketing: { archetype: 'mid', skill: 3, salary: 4_000 },
    finance: { archetype: 'mid', skill: 3, salary: 5_000 },
    rnd: { archetype: 'senior', skill: 4, salary: 11_000 },
  },
  raises: false,
  quits: false,
  loans: false,
  finance: false,
  rnd: false,
  adBudget: false,
  founderRole: false,
  sell: false,
  events: ['latePayer', 'press', 'outage'],
  secondsPerMonth: 20,
  roundSeconds: 600,
  roundMonths: 30,
  lastKnockDays: 30,
  roomSize: 'large',
  autoCloseRooms: true,
  upstairs: true,
};
