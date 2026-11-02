/**
 * Features and R&D tiers. DESIGN.md section 8: feature points accumulate at Σ engineer
 * output per month and a feature ships when points ≥ 4 + features shipped; research
 * points accumulate at Σ researcher output per month, tier 2 at 60 and tier 3 at 150.
 */
import type { GameState } from './types';
import { CONFIG } from './config';
import { featureCost, roleOutput } from './selectors';

const D = CONFIG.time.daysPerMonth;

/** Research points needed for the next tier, or null at the top tier. */
function nextTierAt(tier: GameState['tier']): number | null {
  if (tier === 1) return CONFIG.rnd.tier2Points;
  if (tier === 2) return CONFIG.rnd.tier3Points;
  return null;
}

/** Daily: featurePoints += Σ engineer output / 30; ship while points ≥ cost. researchPoints likewise; tiers at thresholds. */
export function dailyProduct(state: GameState): void {
  // DESIGN.md 8: feature points accrue at Σ engineer output per month (1/30 per day)
  state.featurePoints += roleOutput(state, 'product') / D;
  // the cost is read before each ship: it rises by one point per feature shipped
  while (state.featurePoints >= featureCost(state)) {
    state.featurePoints -= featureCost(state);
    shipFeature(state);
  }

  // DESIGN.md 8: research points accrue at Σ researcher output per month; the thresholds are cumulative
  state.researchPoints += roleOutput(state, 'rnd') / D;
  let at = nextTierAt(state.tier);
  while (at !== null && state.researchPoints >= at) {
    state.tier = (state.tier + 1) as GameState['tier'];
    state.visuals.push({ t: 'tier', day: state.day, tier: state.tier });
    state.log.push({
      day: state.day,
      text: `R&D reached tier ${state.tier}: every price and deal is now ×${CONFIG.rnd.tierMult[state.tier]}.`,
      tone: 'good',
    });
    state.visuals.push({ t: 'toast', day: state.day, text: `R&D tier ${state.tier} unlocked`, tone: 'good' });
    at = nextTierAt(state.tier);
  }
}

/** Ship one feature now (also used by the debug drawer): features += 1, visual 'feature', log, competitor check. */
export function shipFeature(state: GameState): void {
  state.features += 1;
  state.visuals.push({ t: 'feature', day: state.day, features: state.features });
  state.log.push({ day: state.day, text: `Feature ${state.features} shipped: prices and conversion go up.`, tone: 'good' });

  // DESIGN.md 11: the competitor's conversion penalty ends once the target feature count ships
  const until = state.effects.competitorUntilFeatures;
  if (until !== null && state.features >= until) {
    state.effects.competitorUntilFeatures = null;
    state.log.push({ day: state.day, text: 'The competitor next door backed off: you out-built them.', tone: 'good' });
    state.visuals.push({ t: 'toast', day: state.day, text: 'Competitor backed off', tone: 'good' });
  }
}
