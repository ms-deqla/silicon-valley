/**
 * Capex: the catalogue, buying, selling, depreciation, laptops.
 * DESIGN.md section 7. STUB — to be implemented.
 */
import type { Asset, AssetCard, AssetKind, GameState, Verdict } from './types';
import { no } from './types';

/** One card per kind with price, effect text, monthly depreciation, payback estimate and a live verdict. */
export function catalogue(state: GameState): AssetCard[] {
  void state;
  return [];
}

/** desk needs a roomId with free desk capacity; secondFloor once; demoRoom is bought via placeRoom, not here. */
export function canBuy(state: GameState, kind: AssetKind, roomId?: string): Verdict {
  void state; void kind; void roomId;
  return no('not implemented');
}

/** Records capex, creates the asset, applies instant effects (secondFloor → floors = 2; laptop → assignLaptops). */
export function buy(state: GameState, kind: AssetKind, roomId?: string): Asset {
  void state; void kind; void roomId;
  throw new Error('not implemented');
}

/** Desks with someone sitting at them, the second floor with rooms on it, and the demo room cannot be sold here. */
export function canSell(state: GameState, assetId: string): Verdict {
  void state; void assetId;
  return no('not implemented');
}

/** ledger.recordDisposal then remove; laptops → reassign. Returns proceeds. */
export function sell(state: GameState, assetId: string): number {
  void state; void assetId;
  return 0;
}

/** Straight line: cost / lifeMonths per month, never below 0; books via ledger.recordDepreciation. */
export function bookMonthlyDepreciation(state: GameState): void {
  void state;
}

/** Hand laptops to people without one while spares exist; take them back when people leave. */
export function assignLaptops(state: GameState): void {
  void state;
}
