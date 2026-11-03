# BrightByte

A top-down office-floor business sim for the browser. You start in a garage with $50k
and yourself. Open departments, hire, buy assets, raise money, survive events, and sell
the company after year 2.

The point of the game is the HUD: **Profit** and **Free cash flow** disagree constantly,
and the player can always see why (receivables, capex versus depreciation, write-offs),
while **Company value** moves with the investors' required return, so riskier choices
lower the number even when profit is the same.

This is a demo of the world mechanics, not a full game. See [DESIGN.md](DESIGN.md)
for the agreed spec and [CONTRIBUTING.md](CONTRIBUTING.md) for the rules of the repo.

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # dist/index.html, one self-contained file
pnpm test         # vitest: ledger identities, determinism, every module
pnpm typecheck
pnpm balance --seeds 200              # headless strategies × seeds over 60 months; --months 36 for the three-year table
```

Keys: space pauses, 1 and 3 set the speed, D opens the debug drawer, Escape closes sheets.

## Layout

```
src/sim/   the simulation: pure, seeded, deterministic, headless (never imports src/ui)
  types.ts config.ts ledger.ts selectors.ts game.ts   the contract and the tick order
  staff rooms assets product customers valuation capital events hints exit
src/ui/    the DOM shell (controller, HUD, panels, cards) and the canvas office renderer
test/      unit tests per module, cross-cutting identities and determinism, balance smoke
scripts/   strategies.ts (scripted players) and balance.ts (the harness)
```

Every dollar moves through `src/sim/ledger.ts`, and two identities are checked at every
month end:

```
ΔCash = FCF + equity in + loan in − loan repaid
FCF   = Profit + depreciation + disposal loss − capex + disposal proceeds − ΔReceivables
```

Runs are deterministic from a seed plus the action log (`replay()`); the default seed
is today's date so everyone playing on the same day gets the same world.
