# Rules for anyone (human or agent) editing this repo

1. DESIGN.md is the spec. If code and DESIGN.md disagree, DESIGN.md wins; if DESIGN.md
   is silent, pick the simplest rule that keeps the three bars honest and write it down
   in your report.
2. The contract is `src/sim/types.ts`, `src/sim/config.ts`, `src/sim/ledger.ts`,
   `src/sim/selectors.ts`, `src/sim/game.ts`, `src/ui/api.ts`. Do not change exported
   signatures there. You may ADD exports to selectors.ts only if you own no better place,
   and say so in your report.
3. Every number lives in `config.ts`. No magic numbers in sim modules. Do not retune
   config without being asked; balance is a separate step.
4. Every dollar moves through `ledger.ts`. Never write `state.cash +=` outside it.
   The identities in `ledger.checkIdentities` must hold at every close.
5. All randomness goes through `src/sim/rng.ts` with `state.rng`. Never `Math.random`,
   `Date.now`, `new Date()` inside `src/sim`.
6. `src/sim` never imports from `src/ui`. The sim must run headless under Vitest and tsx.
7. Mutate state in place inside sim functions; game.ts owns the tick order.
8. Push a `VisualEvent` for anything the player should see happen on the floor and a
   `LogEntry` for anything they should be able to read later. Toasts for surprises.
9. Only edit the files you own. Other modules are stubs or someone else's work in
   progress; code against their signatures, never their bodies.
10. Before you finish: `npx tsc --noEmit` must pass for your files; run `npx vitest run`
    and make sure your own tests pass (tests for modules that are still stubs may fail;
    say which).
11. Do not run `git commit`. Do not run `pnpm install`/`npm install`.
12. Style: TypeScript strict, no `any` unless unavoidable, small pure helpers, comments
    only where a rule from DESIGN.md is being applied (cite the section).
