/**
 * Every tuning number in the game, named and commented. Nothing in src/sim may
 * hard-code a number that appears here. DESIGN.md sections 5–12 are the prose form.
 */
import type { Archetype, AssetKind, EventType, RoomSize } from './types';

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
      secondFloor: { price: 150_000, lifeMonths: 240, label: 'Second floor' },
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
    featureBaseCost: 4,
    featureCostPerFeature: 1,
    /** price multiplier per feature */
    pricePerFeature: 0.10,
    /** features beyond this no longer raise the price (they still raise conversion) */
    priceFeatureCap: 10,
    /** smb conversion = max × (1 − e^(−k × features)) */
    conversionK: 0.15,
    conversionMax: 0.8,
  },

  rnd: {
    tier2Points: 60,
    tier3Points: 150,
    /** index by tier */
    tierMult: [1, 1, 1.5, 2.25],
  },

  marketing: {
    baseVisitorsPerMonth: 2,
    visitorsPerOutput: 10,
    /** visitors += this × sqrt(ad budget in $k) */
    adVisitorsPerSqrtK: 2,
    adMax: 20_000,
    adStep: 1_000,
  },

  customers: {
    /** the market is finite: conversion and close rate scale by marketSize ÷ (marketSize + customers) */
    marketSize: 600,
    enterpriseShare: 0.10,
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
    base: 0.12,
    burnMax: 0.15,
    burnRunwayMonths: 12,
    rndMax: 0.10,
    leverageMax: 0.08,
    concentrationMax: 0.05,
    recession: 0.05,
    horizonMonths: 60,
    growthMin: -0.10,
    growthMax: 0.08,
    /** trailing growth is measured over this many closed months (shorter while history is short) */
    growthWindowMonths: 6,
    /** trailing growth is trusted in proportion to last month's revenue ÷ this (tiny bases do not forecast) */
    growthTrustRevenue: 20_000,
    terminalGrowthAnnual: 0.02,
    growthDecayMonths: 24,
    /** terminal value is at most this many years of the horizon flow */
    terminalMaxYears: 10,
    runRateMonths: 3,
    arRecovery: 0.9,
    assetRecovery: 0.6,
    acquihirePerSkill: 50_000,
    /** the acqui-hire part of the floor never exceeds this */
    acquihireCap: 1_000_000,
    /** sparkline length */
    historyMonths: 60,
  },

  capital: {
    firstKnockDay: [90, 240] as [number, number],
    knockEveryDays: [120, 240] as [number, number],
    desperationRunwayMonths: 2,
    desperationCooldownDays: 60,
    offerBurnMonths: 6,
    offerValueShare: 0.15,
    offerMin: 50_000,
    offerMinProfitable: 100_000,
    offerRound: 10_000,
    haircutBase: 0.10,
    haircutRisk: 0.25,
    /** r − base spans this range for riskIndex 0..1 */
    riskSpan: 0.43,
    desperationHaircut: 0.5,
    /** an offer never asks for more than this share of the company in one round */
    maxShareSold: 0.4,
    loanBaseRate: 0.04,
    loanRiskShare: 0.5,
    loanTermMonths: 36,
    rolloverMonths: 12,
    rolloverPremium: 0.03,
  },

  events: {
    firstDay: [180, 270] as [number, number],
    everyDays: [90, 180] as [number, number],
    latePayerDelayDays: 60,
    latePayerDefault: 0.15,
    pressPayDays: 10,
    pressNoRenew: 0.5,
    outageFix: 15_000,
    outageLoss: 0.15,
    prPush: 10_000,
    prMult: 3,
    pressMult: 2,
    pressDays: 30,
    competitorMult: 0.75,
    competitorFeatures: 2,
    priceCut: 0.85,
    priceCutDays: 180,
    counterOffer: 0.30,
    recessionVisitors: 0.6,
    recessionDays: 180,
    tightenCut: 0.10,
    tightenMorale: -20,
    /** outage event weight multiplier when servers are short */
    outageShortWeight: 4,
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
