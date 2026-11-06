# BrightByte — design (demo of the world mechanics)

A top-down office-floor business sim. You start in a garage with $50k and yourself.
You open departments, hire, buy assets, raise capital, survive events, and sell the
company after year 2. The HUD shows Cash, Profit, Free cash flow and Company value,
and the point of the game is that Profit and Cash flow disagree constantly, for
reasons the player can see.

This document is the single source of truth for the demo. Everything below was
decided with the owner (two grilling rounds, 30 questions, all accepted on 2026-11-02).

## 0. The tournament (the game as published)

The published game is a ten-minute contest played on the engine that sections 1–16
describe. `RULES` in config.ts says which engine mechanics reach the player; the rest
stay in the code and the tests but never reach the screen. Decided with the owner on
2026-11-03.

- **The round.** A 10:00 wall-clock countdown that never stops. Game time runs at a
  fixed one month per 20 seconds (30 game months in a round, two and a half years).
  No speed buttons. A pause button on the HUD (also Space) stops the countdown and game
  time together; nothing can be done while paused, and the deadline moves forward by the
  time spent paused. Investor and event cards stop the game clock, not the countdown: a
  slow decision costs game months (unless the player pauses first, which is allowed and
  not marked: the board trusts the room). Added 2026-11-06 for live presentations. Leaving the tab costs attention, not
  months: the game catches up to the wall clock when you return (see Clock details).
- **Same world for everyone.** One seed per day (YYYYMMDD) for all players.
- **Score** = company value × the founder's remaining share, taken when the countdown
  reaches zero (the buzzer sells the company). Running out of cash scores 0.
- **What the player can do.** Hire or fire in four departments (Product, Sales,
  Support, Marketing), one fixed kind of person each: mid-level, skill 3, salary
  $5k / $4k / $3k / $4k a month. Buy servers ($20k) and one demo room ($40k). Accept or
  decline investors (equity only). Answer three events: late payer, press, outage.
- **What happens by itself.** A hire gets a desk ($1k) and a laptop ($2k). The first
  hire of any department takes the garage's spare desk; when neither the garage nor a
  room of that department has a free desk or desk space, a room of six desks ($4.5k/mo
  rent) is placed on the next free spot (lowest row first), so capex and rent still show
  in the bars; the lobby appears with the first room. Firing removes the most recent hire
  in that department with three months' severance; an emptied room closes itself (see
  "Space (v2)" below).
- **Switched off.** Candidates, archetypes, quirks, morale-driven raises and quits
  (morale still moves with crowding and overload and scales output), Finance and R&D,
  loans and loan maturity, the ad budget, the competitor, poaching and recession
  events, product tiers, selling assets, selling the company early, room placement and
  closing, the founder's role switch (you stay in Product).
- **Clock details.** Game time rides the wall clock: if you leave the tab, the game
  catches up when you return; a card left open keeps the game paused while the clock
  runs. No scheduled investor knock opens in the last 30 game days of the round (money
  that arrives in the final month cannot be used); lifelines still can.
- **Screen.** The four HUD numbers, the why line and the hint line stay; Books is one
  tap away. The countdown and a live leaderboard sit on the main screen; the bottom of
  the screen is one control board: a row per department (headcount, cost, −/+) and the
  two asset buttons.
- **Live leaderboard.** Each player posts name, seed, current value, month and status
  every game month, and the score at the end, to the page's shared store: one
  document per player (`scores/<viewer id>`), readable by everyone, writable only by
  that player. Everyone on today's seed is ranked by one standing: the score for a
  finished run, or value × share (what the buzzer would pay now) for a running one, so
  a run that went out of cash sinks; a run not updated for two rounds counts as left
  mid-round and sits last. A player's best finished score of the day is kept across
  replays and ranks the final tables. Where the shared store is absent (local dev) the
  page shows the local player only and says "Local only"; a viewer the store will not
  write for sees everyone else and is told their run is not on the shared board; when
  the store is slow the strip says the board may be out of date.

- **Name.** The game is "Silicon Valley"; the company the player builds is BrightByte.
- **Your stake (v2).** The fourth HUD pill is "Your stake": the score if the buzzer went
  now (value × your share), with "69% of $1.2M" as its small line. A thin cap-table bar
  under the pills shows your slice in your colour and each investor round as a grey
  segment with the fund's initials. Books has a cap table (you, each fund, percentages).
- **Dilution math on cards (v2).** Every investor card shows before → after: "You own
  69% → 59%. Your stake today $821k → $870k. Value $1.2M → $1.25M." The decline choice
  reads "Keep 69%".
- **Space (v2).** Department rooms open large (6 desks). A room closes itself the moment
  its last person leaves: its desks are sold at 60% of book and the rent stops. When the
  ground floor is full the next hire builds the second floor for a one-off $60k, shown
  on the + button as "+ $60k upstairs". The demo room keeps its footprint. Space never
  blocks a hire until about 85 people (the garage's spare desk, six rooms downstairs and
  eight upstairs on the 6×8 grid), far beyond a round.
- **Coach (v2).** An advisor in the sim (`advisor.ts`) names the single best next action
  with a reason, from the Playbook rules in section 18. The hint line becomes the coach
  line with a tap that does it; the recommended board row pulses softly; every investor
  and event card carries a coach badge with the recommendation and its reason. Advice
  only, never automatic, the same for every player.
- **Tutorial (v2).** On the first Start a coach-mark tour runs over the real screen with
  the clock not yet running: nine stops, each pointing at the control it explains, Skip
  on every stop; the countdown starts when the tour closes. A Playbook page (section 18)
  opens from "How to play" on the start screen and from a "?" in the HUD (the clock
  keeps running). All numbers in both are generated from config so they never drift.
- **Practice (v2).** A second start button, "Practice (not scored)": the same round on
  the same world, nothing posted to the board, the result screen says so.
- **Post-mortem (v2).** The result screen adds two or three generated takeaways and a
  timeline of your stake over the months with markers for hires, rounds, events and
  purchases (section 20).
- **Tournament code (v2).** An optional field on the start screen: everyone who types the
  same word plays the same world (seed = hash of the word) and shares that world's
  board. Empty means today's world.
- **Colours and pace (v2).** Each player picks one of eight colours at the start (stored
  with their score); the strip uses it, and under your chip it says how far you are
  behind the leader ("$120k behind Katia").
- **Share (v2).** "Copy result" on the result screen copies one line: "Silicon Valley,
  4 Nov: $821k, 69% owned, 17 months. Beat me: <link>".
- **Audio (v2).** Section 19.

## 1. Scope of the demo

In: all six departments, people, assets, the three bars + value, valuation with risk
premia, investor knocks (equity / loan), six events, exit and game over, a Books panel
with the cash bridge, a hint line, a debug drawer, seeded determinism, local
leaderboard.

Out: sound, tutorial, save/load, shared leaderboard backend, real art assets,
localisation, app-store packaging, balance beyond "a five-year run is playable
without trivially winning or dying".

## 2. Platform, form factor, stack

- Browser. Portrait column (9:16, 420×840 CSS px design size) that scales to fit any
  viewport and sits centred on desktop. Touch and mouse.
- TypeScript + Vite + Vitest. Canvas 2D for the office floor, DOM for HUD, panels and
  cards. No game engine, no framework.
- The simulation (`src/sim`) is pure, seeded and deterministic. It never imports
  from `src/ui`. It can run headless (balance harness, tests).
- Single-file build (`vite-plugin-singlefile`) so the game is one HTML file.
- English only, single player.

## 3. Art register

Soft stylised 3D look drawn procedurally: pastel department colours, rounded rooms
with short extruded walls on the back and side edges (steep three-quarter
"dollhouse" view, screen-aligned rectangles, NOT an isometric diamond grid), soft
drop shadows, big-headed characters (head ≈ 45% of figure height), glassy HUD pills
with backdrop blur. Department colours: Product/Engineering blue `#5B8DEF`,
Sales green `#5FBF7A`, Support orange `#F2A94A`, Marketing purple `#A77BEF`,
Finance teal `#4FB9C9`, R&D indigo `#6C6FD8`, Reception/lobby pink `#F28CB1`,
garage warm grey `#C9BFB2`. Floor wood `#E8D7BE`, street `#B8BDC4`, grass `#A9D68B`.
Buttons: Hire blue, Build amber, Invest green, Sell purple (frame 2 of the concept).

## 4. Clock

- One game month = 30 game days = 30 s at 1×. The sim ticks once per game day.
- Speeds: pause, 1×, 3×. Investor and event cards pause the clock.
- Month end ("close"): books close, HUD history snaps, valuation is recomputed.
- The HUD shows month-to-date figures live. Calendar badge shows Year / Quarter / Month.
- No hard time limit. Score is taken only when the player presses Sell.

## 5. The building

- Grid of cells, 6 wide × 8 tall per floor. Floor 0 and, after buying the second
  floor, floor 1 drawn stacked above it with a staircase.
- Fixed on floor 0: the garage (2×2 at bottom-left, x=0,y=6) and the lobby (2×2 at
  bottom-centre, x=2,y=6) with the street door on its bottom edge. The lobby appears
  rent-free when the first room is placed; before that the garage door is the door.
- Rooms: one department each. Sizes: small 2×2 (max 4 desks, rent $3k/mo), large
  3×2 (max 6 desks, rent $4.5k/mo). Garage: rent-free, max 2 desks, any role may
  sit there. Demo room: a 2×2 block placed like a room, capex only, no rent.
- Placing a room: Build → department → size → tap a free, in-bounds spot. Rent
  starts at once. Closing a room fires its staff (severance) and sells its desks at
  60% of book automatically.
- Geometry is cosmetic. Outcomes come from department capacity, never distance.

## 6. People

- Roles map one-to-one to departments: product (engineer), sales (rep), support
  (agent), marketing (marketer), finance (finance), rnd (researcher).
- Archetypes: junior (skill 1–2, cheap, +0.1 skill/month up to 3), mid (2.5–3.5),
  senior (4–5, expensive), star (5, 10% commission on enterprise deals, asks for
  raises every 6 months).
- Quirks (one each): coffee (−15 morale without a coffee machine), crowd (−20 morale
  when room is at capacity), mentor (juniors in the same room learn 2×), mercenary
  (poaching target, quits at morale < 35), loyal (never quits), diva (raise ask every
  6 months instead of 12).
- Morale 0–100, moves toward a target each day. Target = 70 + desk&laptop (0 / −25)
  + coffee machine (+10) − crowding (room at capacity: −10) − overload (dept demand >
  capacity: −15) + recent raise granted (+15 for 3 months) − raise refused (−30 for 6
  months) ± quirk terms, clamped.
- Output = skill × (0.5 + morale/200); ×0.5 without a laptop.
- Raise request every 12 months (+15%); refusing applies the morale penalty. Morale
  < 20 → 10% chance per month to quit (loyal never). Firing = 3 months' salary now.
- Hiring needs a free desk in that role's room (or the garage). Candidates: 3 per
  role, refreshed every month end. Salaries: junior $4k, mid $7k, senior $11k,
  star $14k per month (±10% noise).
- The founder is a free generalist (no salary, skill 3) assignable to product or
  sales. Counted as staff for capacity and for the acqui-hire floor.
- Laptops are company assets handed out automatically (one per person); spares keep
  depreciating and can be sold. Desks are per-room assets.

## 7. Assets (capex)

| kind        | price  | life | effect |
|-------------|--------|------|--------|
| desk        | $1k    | 5y   | +1 seat in a room (needs free capacity) |
| laptop      | $2k    | 3y   | one per person, else that person works at 50% |
| server      | $20k   | 4y   | 1 per 50 customers (needed = floor(customers ÷ 50), the first at 50); each missing server = 10%/month outage chance |
| coffee      | $5k    | 5y   | +10 morale for everyone, fixes "coffee" quirk |
| demoRoom    | $40k   | 10y  | enterprise deals ×1.3; occupies a 2×2 block |
| secondFloor | $60k   | 20y  | adds floor 1 (another 6×8 grid); built by itself in the tournament when the ground floor is full |

Straight-line depreciation booked at month end. Resale = 60% of book value; the
P&L takes the loss. Each card shows price, monthly effect, monthly depreciation
and a payback estimate (price ÷ estimated monthly cash benefit).

## 8. Customers and revenue

- Visitors per month = 6 + 6 × Σ marketer output + 2 × √(ad budget in $k), × 2
  during press (×3 with PR push), × 0.6 during recession. Arrivals are Poisson per day.
- 15% of visitors are enterprise prospects; they need a sales rep. The rest are SMB.
- The market is finite: conversion and the enterprise close rate are multiplied by
  saturation = marketSize ÷ (marketSize + current customers), marketSize 150.
- SMB conversion = 0.5 × (1 − e^(−0.15 × features)) × saturation × 0.75 if a
  competitor is active. Converted: a subscriber paying monthly price = $300 ×
  (1 + 0.1 × min(features, 10)) × tier multiplier (× 0.85 during a price cut).
  Existing subscribers are re-priced at the live price every month end (features
  and tiers raise everyone's price; a price cut lowers everyone's). Billed at month
  end: cash and revenue in the same month.
- Enterprise: prospect waits in the lobby up to 45 days for a rep with free capacity.
  A rep closes output × 0.5 deals per month of attention; close probability = 0.5 ×
  the feature factor × saturation, × 0.75 while a competitor is active (the same
  penalty as SMB conversion). Deal (annual contract) = $30k × (1 + 0.1 × min(features,
  10)) × tier multiplier (× 0.85 during a price cut) × 1.3 with a demo room. The full
  contract value is booked as revenue when signed; an invoice is issued, due in `terms`
  days (90, minus 5 per finance skill point, floor 30). Cash arrives on the due day.
  Star reps take 10% commission in cash at signing. Enterprise customers renew (a new
  deal + invoice) after 12 months if served ≥ 50% of their tickets, else they leave.
- Churn (SMB, daily hazard from a monthly rate) = 2% + 6% × share of tickets
  unserved. Tickets = 0.3 per customer per month; an agent serves 15 × output.
- Servers: floor(customers ÷ 50) needed, so the first server is due at 50 customers; shortfall drives outage risk (section 11).
- Features: feature points accumulate at Σ engineer output per month; a feature
  ships when points ≥ 3 + features shipped. Price and conversion use the feature
  count. R&D tier multiplier: tier 1 ×1, tier 2 ×1.5, tier 3 ×2.25.
- R&D: available from the start. Research points accumulate at Σ researcher output
  per month; tier 2 at 60, tier 3 at 150. Researchers are paid like seniors.
- Marketing: needs the room. Ad budget slider $0–$20k per month in $1k steps, opex
  accrued daily. No room → no slider, no spend.
- Finance: unlocks the day the first enterprise invoice is issued. Each finance
  skill point of output cuts terms on new invoices by 5 days (floor 30), halves the
  default chance on late payers, and the room's existence enables the loan option.
- Competitor (event): conversion × 0.75 until two more features ship.

## 9. Accounting — the three bars

Profit (accrual, month to date):
  + SMB fees billed + enterprise contracts signed
  − salaries − rent − ad spend − loan interest − depreciation − severance
  − bad debt (invoice written off) − commission − disposal loss − event costs

Free cash flow (month to date):
  + SMB receipts + invoice collections + asset disposal proceeds
  − salaries − rent − ad spend − interest − severance − commission − capex − event costs

Cash: bank balance, including financing (equity in, loan in, loan repaid, prepay).

Daily accrual: salaries, rent, ad budget and loan interest accrue 1/30 per day in
both bars. Depreciation is booked at month end. Commission is paid in cash at
signing. No tax. Equity and loan cash land instantly.

Identities (tested every close):
  ΔCash = FCF + equityIn + loanIn − loanRepaid
  FCF = Profit + depreciation + disposalLoss − capex + disposalProceeds − ΔReceivables
  where ΔReceivables = AR(end) − AR(start) and AR counts open invoices only.
  (Bad debt sits in both Profit and ΔReceivables so it cancels; capex sits in FCF
  while depreciation sits in Profit; enterprise revenue sits in Profit while the
  cash arrives later. Those three are the course.)

Game over: at a month-end close with cash < 0, after one last desperation knock in
the current crisis. Loan maturity failure is also game over (section 10).

## 10. Valuation and capital

Required return r (annual) = 0.12 base
  + burn premium: if FCF run-rate < 0, 0.15 × clamp(1 − runway/12, 0, 1), runway = cash ÷ monthly burn
  + R&D premium: (R&D salaries ÷ total monthly costs) × 0.10
  + leverage premium: debt ÷ (debt + last month's value) × 0.08
  + concentration premium: largest customer's annualised revenue ÷ total annualised revenue × 0.05
  + recession: 0.05 while active

Forecast: base = average of the last 12 closed months of (FCF + capex − disposal
proceeds − depreciation) i.e. operating cash flow after maintenance capex. Growth g0
= trailing revenue growth per month, comparing 3-month average revenues 6 months
apart (or the longest window available, at least 2 months; annual enterprise
bookings are lumpy), multiplied by a trust factor = min(1, the recent 3-month
average revenue ÷ $20k) × min(1, window ÷ 6), so a few hundred dollars of revenue
never forecast a rocket; clamped to [−4%, +4%] per month, decaying linearly to
0.17%/month (2%/yr) over 12 months. Project 60 months, discount at monthly rate
(1+r)^(1/12) − 1, add a terminal value at month 60 at 2%/yr growth (only if the
month-60 flow is positive), capped at 5 years of that flow. DCF is an enterprise value.

Operating value = max(0, DCF + cash − debt). This is what investors size offers on.

Floor = cash + 0.9 × open receivables + 0.6 × assets at book − debt
        + acqui-hire value min(Σ(skill × $50k) over the founder and every person hired
        at least 90 days ago, $1M): acquirers pay for a team that has worked together,
        so a last-minute hiring spree adds nothing.
        (Founder alone at start: $150k + $50k cash = $0.2M, as in the concept HUD.)

Company value = max(operating value, floor). Equity value: debt already netted.
Shown as one number with a 12-month sparkline. Tapping shows "Investors want r%"
with each premium listed.

Investor knocks: first at a random day in [45, 120], then every [120, 240] days.
Desperation knock when runway < 2 months (at most once per 60 days), but never
before investors have knocked once on their own schedule; the crisis knock at a
month-end close with cash < 0 (section 9) is always available. Offer amount
= max(6 × monthly burn, 15% of operating value), min $50k, rounded to $10k; if
profitable, max(15% of operating value, $100k). One round never sells more than 40%
of the company: the amount is cut to fit (so a company with no operations can only
raise against its floor, and hiring cannot pump the next offer).
- Equity: haircut = 0.10 + 0.25 × riskIndex, riskIndex = clamp((r − 0.12) ÷ 0.43, 0, 1).
  Pre-money = value × (1 − haircut). Share sold = amount ÷ (pre-money + amount).
  Founder share multiplies by (1 − share sold). Desperation knock: haircut 0.5.
- Loan: annual rate = 0.04 + (r − 0.12) ÷ 2. Interest accrues daily. Principal due
  in one payment 36 months after drawdown. Greyed out (with a hint) without a
  Finance room, or while a loan is outstanding. Prepay any time, no penalty.
- Maturity: if cash < principal on the due day, the bank offers one rollover for 12
  months at +3%; refusing or failing that is game over.
- Declining a knock costs nothing.

## 11. Events

The first card lands on a random day in [180, 270] (none before day 180), then one
every [60, 150] days; one card at a time, clock paused. An event needs a company of
some size: outage from 20 customers, competitor from 5, recession from 10; late
payer, press and poaching have no minimum (they have their own preconditions).

1. Big customer pays late (needs an open enterprise invoice): "Wait" → due +60 days,
   15% chance it is never paid (write-off, halved with finance staff). "Press them"
   → paid in 10 days, 50% chance that customer will not renew.
2. Server outage (weighted up when servers are short): "Emergency fix" → −$15k event
   cost. "Ride it out" → lose 15% of customers.
3. Press coverage: "PR push" → −$10k, visitors ×3 for 30 days. "Enjoy it" → ×2 for 30 days.
4. Competitor next door: "Out-build them" → conversion ×0.75 until 2 more features
   ship. "Cut prices" → no conversion penalty, all prices ×0.85 for 180 days.
5. Star employee poached (needs a senior or star): "Counter-offer" → +30% salary.
   "Let them go" → they leave, no severance.
6. Recession: visitors ×0.6 and +5% required return for 180 days. "Tighten" → all
   salaries −10% for 180 days, morale −20. "Hold the line" → nothing else.

## 12. Exit, score, seeds, leaderboard

- Sell is enabled from day 720 (month 24) and always shows the live offer.
- Offer = company value. Score = offer × founder share. The result screen shows
  offer, share, debt, score and a run summary.
- Game over screen shows the same summary with score 0.
- Runs are deterministic from a seed and the action log. Default seed = today's
  date (YYYYMMDD) so everyone plays the same world; a custom seed can be typed.
- Leaderboard: localStorage only — name, score, seed, date, months played.

## 13. UI

- HUD (top): four glassy pills — Cash, Profit (MTD), Cash flow (MTD), Company value
  with sparkline. Below: calendar badge, speed controls, settings gear.
- Under the HUD: the "why" line (one sentence naming the biggest cash-bridge item,
  e.g. "Profit up, cash down: $184k is owed to you") and the hint line (contextual
  one-liner, priority-ordered rules).
- Four buttons at the bottom: Hire, Build, Invest, Sell.
  - Hire: Candidates tab (3 per role; disabled with a reason when there is no desk
    or no cash) and Team tab (rows with role, skill, salary, morale; founder role
    toggle; pending raise → Grant / Refuse; Fire shows the severance cost).
  - Build: departments with rent and size; placement mode on the canvas; close room.
  - Invest: Assets (catalogue + owned with Sell at 60% book) and Capital (current
    loan, prepay; founder share; rounds; the open knock if any).
  - Sell: offer, share, debt, score preview; enabled from month 24; confirm.
- Books (tap any HUD pill): this month's P&L; cash bridge; invoice tray list with due
  dates; mini balance sheet (cash, receivables, assets at book, debt, your share);
  12-month history table.
- Cards (investor, events, maturity, game over, sold): modal, title, drawn portrait,
  body, quote, choices.
- Crowd: up to 12 walking figures; beyond that a figure carries a "×N" badge. Coin
  popups aggregated per customer kind per day. Non-converts leave with a grey puff.
- Debug drawer (press D): 10× speed, +$100k, force knock, force event, show seed.

## 14. Architecture and contracts

```
src/sim/types.ts      state, actions, cards, visual events (THE contract)
src/sim/config.ts     every tuning number (section 15)
src/sim/rng.ts        seeded PRNG (sfc32) and helpers
src/sim/ledger.ts     transaction recording + month close + identities
src/sim/selectors.ts  derived numbers: capacities, outputs, costs, runway, AR
src/sim/game.ts       createGame, advanceDay, closeMonth, dispatch (tick order)
src/sim/staff.ts      candidates, hire/fire, morale, raises, quits, learning
src/sim/rooms.ts      grid, placement validation, open/close, seats
src/sim/assets.ts     catalogue, buy/sell, depreciation, laptops, effects
src/sim/product.ts    features, research tiers
src/sim/customers.ts  visitors, conversion, prospects, deals, invoices, churn, tickets
src/sim/valuation.ts  required return, DCF, floor
src/sim/capital.ts    knocks, equity, loans, maturity, prepay
src/sim/events.ts     the six events
src/sim/hints.ts      why line + hint line
src/sim/exit.ts       sell, score, game over
src/ui/*              renderer (canvas), hud, panels, cards, controller, styles
test/*                identities, determinism, valuation, balance smoke
scripts/balance.ts    headless strategies × seeds, prints survival and scores
```

Tick order (`advanceDay`):
1. If `state.card` is open or status ≠ playing: return (no time passes).
2. `day += 1`.
3. Daily accruals: salaries, rent, ad budget, loan interest (1/30 of monthly).
4. Staff daily: morale drift, learning (monthly fraction).
5. Product: feature points, research points; ship features / tiers.
6. Customers: visitors (Poisson), SMB conversion, prospects matched to reps, deals
   closed (revenue + invoice + commission), invoice collections due today, SMB
   churn, enterprise renewals/leavers, prospect expiry.
7. Effects expiring (press, recession, price cut, salary cut).
8. Capital: loan maturity check (card), desperation knock, scheduled knock.
9. Events: scheduled event (card).
10. If `day % 30 === 0`: `closeMonth`.

Month close (`closeMonth`):
1. Bill SMB subscriptions (revenue + cash).
2. Depreciation for every asset; retire fully-depreciated ones at book 0 (keep, value 0).
3. Tickets served ratio for the month → stored for churn next month; enterprise served flags.
4. Staff monthly: raise requests, quits, candidate refresh, learning.
5. Finalise `book` → push to history; start a new book (carry cash/AR/assets/debt).
6. Valuation recompute; push to sparkline.
7. Finance unlock check; outage roll (servers short).
8. Game over check (cash < 0 → desperation card first, then game over).

`dispatch(state, action)` validates with `canDispatch` (same reasons used by the
UI to disable buttons) and mutates state. All randomness goes through `state.rng`.
`state.visuals` is a queue of visual events the renderer drains each frame.

## 15. Tuning table (config.ts is the code form of this table)

See section 6–11 for the numbers; config.ts must contain every one of them as a
named constant with a comment, and nothing in the sim may hard-code a number that
appears here.

## 16. Verification

- Unit tests: ledger identities after every close over random action sequences;
  determinism (same seed + same action log → same JSON state); valuation (founder
  alone ≈ $200k; each premium raises r; a higher r lowers value with the same
  flows); capital (share maths, loan maturity); events (each choice has its effect).
- Balance harness (`pnpm balance`): strategies idle / engineer-first / sales-first /
  balanced / reckless × 200 seeds × 60 months. Targets at month 36, medians over the
  seed set: balanced survives ≥ 70%; reckless dies ≥ 50%; idle never dies and its
  median value stays under $1.5M (a free founder for three years earns a small
  business, not an exit); balanced median score between $1M and $15M with p90 under
  $50M; balanced median score at least 2.5× idle's median value (the engine's team
  value vests over 90 days, which trims a hire-heavy player). Engineer-first and
  sales-first rows are informational.
- Pacing (the first ten real minutes must have things happening), medians over the
  seed set: the idle founder ships the first feature by day 45 and has a paying
  customer by the end of month 4; a balanced player has an enterprise prospect in the
  lobby by month 6 and signs the first enterprise deal by month 9; the first investor
  knock lands between month 3 and month 8; a sane player (balanced) sees at most one
  event card per three months on average.
- Five-year guard (section 1: a five-year run is playable without trivially winning
  or dying), read at month 60: balanced still survives ≥ 70%; its median company
  value stays under $75M and its p90 under $100M (a strong year-five business, not
  a unicorn); idle's median value stays under $2M. A run shorter than 60 months
  prints these as n/a.
- The harness prints all three lists with PASS / FAIL after its tables;
  test/balance.test.ts asserts the same lists at 20 seeds.
- Tournament (section 0, the published rules): the tournament strategies × 200 seeds
  × 30 game months, everything read at the buzzer, medians over the seed set. The
  scripted player (tPlayer) follows the coach of section 18 exactly, so the harness
  measures the advice: each day it dispatches the advised action when the urgency is
  "now" or "soon", and an "idea" once cash tops $100k (one tap a day); every card is
  answered as `adviseCard` says, and where the coach has no view (a card kind without a
  rule) it falls back to a careful founder's answers: the first two investor knocks
  taken, every later scheduled knock declined, every lifeline (desperation knock)
  taken. The coach's thresholds live in `CONFIG.coach`, which the Playbook texts and
  the harness read too. tTakeAll is the same follower taking every investor card;
  tDeclineAll the same follower declining every one (lifelines included); tIdle never
  acts; tAggressive (an engineer every month cash allows, every knock taken, the
  coach's other advice followed) is informational. Targets: tPlayer survives
  ≥ 80% and is dead by month 6 in at most 5% of the seeds; tPlayer median score in
  [$2M, $6M] (a coach-following player over two and a half years: a business, not an
  exit); tPlayer median score ≥ 2 × tIdle median score; tTakeAll median ≤ 1.5 ×
  tPlayer median (raising is a trade-off, not a free lunch); tDeclineAll median ≤
  tPlayer median; tIdle median under $1.5M. Pacing (tPlayer medians): the first
  paying customer by month 3, the first signed enterprise deal by month 8, the first
  investor knock by month 4; at least one investor card and one event card per round
  in 90% of the seeds; no stretch longer than 120 s without an investor or event
  card (p90 of the longest stretch over the seeds). The buzzer is not a lottery on
  invoice timing: the company value falls by at most 20% between two closes after
  month 12 (median of the biggest fall over surviving rounds). The engine-only
  strategies above run under the full engine (`--full`).

## 17. Visual language (from the three Figma frames)

- **Type.** Nunito from Google Fonts (600, 700, 800) with a rounded system fallback;
  `font-variant-numeric: tabular-nums` on every number. Headlines 800, labels 700
  small caps-ish (letter-spacing 0.02em), body 600.
- **Surfaces.** Glass pills: white at 72% with a 12px backdrop blur, a 1px white stroke
  at 60%, radius 18px, soft shadow (0 6px 18px rgba(20,24,40,0.12)). Cards: white, radius
  24px, shadow 0 18px 40px rgba(20,24,40,0.18). Action buttons: filled, radius 16px, 56px
  tall, white 800 text; secondary buttons pale (tint of the accent at 12%).
- **Accents (the four buttons of the frames).** Blue #3B82F6 (Product, Hire), amber
  #F59E0B (Build, rooms), green #22C55E (Invest, take equity, money in), purple #8B5CF6
  (Sell, score). Department colours stay as section 3. Semantic: good green, bad red
  #E5484D, warn amber. Scene pastels unchanged.
- **Icons.** One inline-SVG set (24px grid, 2px rounded strokes): banknote stack (cash),
  trend arrow (profit, up/down), bars (cash flow), building (value), pie (stake),
  person-plus, person-minus, wrench (Product), handshake (Sales), headset (Support),
  megaphone (Marketing), server, screen (demo room), coin, calendar, gear, speaker on /
  off, question, play, copy, trophy, flag.
- **HUD.** Four glass pills, icon left in its accent colour, label small, number large.
  Calendar badge: a small white card with a blue header strip ("Year 2 · Q1") and the
  month and day below. Countdown: dark pill, white 800 digits, amber under 2:00, red
  under 0:30. Cap-table bar: 8px tall, radius 4, your colour, grey rounds with initials
  on hover/tap. Sparkline in the value pill: 2px line, area fill at 15%.
- **Board.** One tile per department: icon in a tinted circle (department colour), name
  and headcount line, the − button pale, the + button filled in the department colour
  with its salary and a caption line. Servers and demo room tiles in grey-blue and
  purple. The coach's recommended tile pulses (opacity 0.65–1, 1.2 s) and shows a small
  "coach" chip. Respect prefers-reduced-motion (no pulse, chip only).
- **Cards.** Portrait circle (initials on a pastel blob), eyebrow ("INVESTOR" / "EVENT"),
  title 800, speaker line, italic quote in a pale box, body, the coach badge (a pill with
  the trophy icon and "Coach: take it · 2 months of cash left"), then the choices: the
  recommended one green, the other blue or grey, each with label and detail; footer line
  about the clock.
- **Floor feedback.** Coin popups as green pills with a coin icon ("+$12k"), invoice slips
  white with a blue line, the "Owed to you $184k" sign white with a dark border and a
  pointer at the tray, "Build here" dashed plots with a plus on free slots.

## 18. Tutorial and coach

Tour (first Start, clock not running, Skip on every stop), one sentence or two per stop,
numbers generated from CONFIG/RULES:
1. Goal and clock: "Ten minutes. Score = company value × the share you still own when
   the buzzer sells the company. Cards stop the game, not the clock."
2. The pills: "Cash pays salaries and ends the game below zero. Profit counts invoices
   you have not been paid yet. Cash flow is what really moved. Your stake is your score."
3. Product: "Engineers ship features. Your first lands in about five weeks on your own;
   two engineers ship twice as fast. Every feature raises the share of visitors who buy
   (18% at three features, 39% at ten) and the price 10%. Nothing else works until the
   first feature exists."
4. Marketing: "Marketers bring people to the door. With nobody in Marketing about 6
   visitors a month wander in; each marketer adds about 15. Visitors only become
   customers if you have features, so marketing before your first feature is wasted
   money. Each small customer pays $300 a month, plus 10% per feature. Hire your first
   marketer when the hint says visitors are a trickle (around three features); a second
   once Profit shows the first one pays for itself. More customers means more tickets and
   more servers, so Support and a server follow."
5. Sales: "About one visitor in seven is a company, not a person. Companies wait in the
   lobby for a sales rep; with no rep they give up after 45 days. A rep works one deal at
   a time, about a month each, and closes roughly half. A deal is a yearly contract worth
   $30k plus 10% per feature (a third more with a demo room). The whole contract counts
   as profit the day it is signed, but the cash arrives 90 days later: that is the tray
   at reception and the reason Profit and Cash flow disagree. Hire a rep the moment a
   prospect is waiting and you can cover three months of their pay; a second when
   prospects queue. A rep with no prospects is pure cost."
6. Support: "Customers raise tickets. With nobody answering, 8% of them leave every
   month; one agent keeps that at 2% up to about 120 customers. Hire from about 10
   customers."
7. Servers and demo room: "One server per 50 customers. Each missing server is a 10%
   chance per month of an outage that loses 15% of your customers. Cash leaves now;
   profit only sees a small slice each month. The demo room: $40k once, enterprise deals
   a third bigger. Worth it when a rep is closing."
8. Investors and events: "Cash now for a slice forever. The first offer comes in month 2
   to 4 and prices your team and your cash, because the business is not worth anything
   yet; early offers cost 15–40%, later ones 5–10%. Take money you can spend inside the
   round; decline the rest. If the bank runs dry a lifeline comes at half price. No
   offers in the last month. Late payer: press them if you need the cash. Press
   coverage: pay for the push if you have features to sell. Outage: pay the fix when the
   customers at stake are worth more than $15k."
9. The strip and firing: "Everyone is ranked by what the buzzer would pay them now.
   Firing costs three months' pay; an emptied room closes itself."

Playbook page: the scaling sequence, then the nine texts above as sections, then the
three bars explained. Sequence: "Minute 0–1: an engineer. Minute 1–2: take the first
investor. When the hint says visitors are a trickle: a marketer. When a prospect is
waiting: a rep. At 10 customers: a support agent. At 50 customers: a server. With more
than $100k in the bank: the demo room and a second engineer, then a second marketer.
After the second investor, decline unless you can spend the money before the buzzer.
Answer every card at once: it stops your game, not the clock. Watch three things: the
hint line, the lobby, and the strip."

Coach rules (`advisor.advise`, first match wins; every number from config/RULES; the
advice carries the action to dispatch, a label, a reason and an urgency now/soon/idea):
1. A card is open → card advice (`adviseCard`): investor knock, in this order: take
   when the cash would run out before the buzzer (runway shorter than the month-end
   closes still to come, since cash below zero at a close scores 0); decline when fewer
   than 4 game months remain; take when runway < 6 months; take a share ≤ 15% with at
   least 6 game months left only while fewer than 2 rounds were taken or the money would
   not push cash above $100k (the Playbook: after the second investor, decline unless you
   can spend it); otherwise decline. Lifeline (desperation / crisis): take when cash < 0
   or the cash would run out before the buzzer, else decline (a crisis knock at the
   close still comes). Late payer: press when cash <
   3 months of costs, else wait. Press coverage: push when features ≥ 3 and cash > $25k.
   Outage: fix when customers lost × average monthly price × months left > the fix cost.
2. No features and no engineer → hire an engineer (now).
3. A prospect waits, no rep, cash covers 3 months of the new run-rate → hire a rep (now).
4. Servers short and cash ≥ price → buy a server (now).
5. Customers ≥ 10 and no support agent, cash rule → hire support (soon).
6. Features ≥ 3 and no marketer, cash rule → hire a marketer (soon).
7. Customers > 120 × support agents → another agent (soon).
8. Cash > $100k, a rep hired, no demo room → build the demo room (idea).
9. Cash > $100k → another engineer, then another marketer (idea), alternating by count,
   up to a second of each (an uncapped version hires into a cash crunch and lifelines;
   the Playbook says "a second engineer, then a second marketer").
10. Runway < 2 months and no card → "Hold on: a lifeline comes if the bank runs dry.
    Don't hire." (now, no action).
11. Otherwise: "Watch the lobby and the strip." (idea, no action).
The scripted tPlayer follows the coach exactly, so the balance harness measures the
advice.

## 19. Audio

Web Audio only (no files): a lo-fi loop at 84 BPM, 16 bars, chords Cmaj7 – Am7 – Fmaj7 –
G7 on a soft triangle pad through a low-pass filter, a sine bass on the roots, a sparse
pentatonic pluck chosen by a non-sim random, a soft kick and hat from filtered noise;
master gain 0.25. Starts on the Start tap (browsers refuse sound before a gesture).
Effects: coin (two short sine blips) when cash lands, knock (two filtered noise taps)
when an investor card opens, page (a noise sweep) when an event opens, buzzer (a square
chord, one second) at the end, click (a tick) on board actions. A speaker button in the
HUD and on the start screen, default on, remembered on the device under `sv.audio`.
When the AudioContext cannot be created the button is hidden.

## 20. Post-mortem, timeline, codes, colours, sharing

Takeaways (`postmortem.takeaways`, the three with the highest impact in $, each a title
and a detail with the numbers): raised but unspent (equity in vs cash at the end: "You
raised $X and ended with $Y unspent: Z% of your share for cash you never used");
cards left waiting (wall-clock ms with a card open, from the controller: "Cards waited
N s: M game months lost"); support too late (first support hire's customer count vs 10
and the customers churned before it); servers too late (outages suffered and customers
lost); marketing too late (first marketer month vs the month features reached 3); idle
cash (months with cash > $150k and no hire); out of cash (costs vs revenue in the last
month). Timeline (`postmortem.timeline`): one point per closed month with value, share
and stake, plus markers for hires (role), rounds, events, servers, the demo room and
the second floor, drawn as a small SVG on the result screen.

Tournament code: seed = hashSeed(code) when the field is not empty; the leaderboard
query is by seed, so every code has its own board. Colour: one of eight named pastel
colours chosen on the start screen, stored as `color` in the player's document, used in
the strip and the tables. Pace line under your chip: "$X behind <leader>" or "You lead".
Copy result: `navigator.clipboard.writeText` inside the click handler with a selectable
fallback.
