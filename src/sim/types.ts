/**
 * THE CONTRACT. Every module in src/sim and src/ui codes against these types.
 * See DESIGN.md for the rules behind each field.
 */

export const DAYS_PER_MONTH = 30;

export type Id = string;

// ---------------------------------------------------------------- people
export type Role = 'product' | 'sales' | 'support' | 'marketing' | 'finance' | 'rnd';
export const ROLES: readonly Role[] = ['product', 'sales', 'support', 'marketing', 'finance', 'rnd'];
export const ROLE_LABEL: Record<Role, string> = {
  product: 'Product', sales: 'Sales', support: 'Support', marketing: 'Marketing', finance: 'Finance', rnd: 'R&D',
};
export const ROLE_JOB: Record<Role, string> = {
  product: 'Engineer', sales: 'Sales rep', support: 'Support agent', marketing: 'Marketer', finance: 'Finance', rnd: 'Researcher',
};

export type Archetype = 'junior' | 'mid' | 'senior' | 'star';
export type Quirk = 'coffee' | 'crowd' | 'mentor' | 'mercenary' | 'loyal' | 'diva';

export interface Person {
  id: Id;
  name: string;
  role: Role;
  archetype: Archetype;
  quirk: Quirk;
  /** 1..5, juniors grow */
  skill: number;
  /** monthly, before temporary cuts; 0 for the founder */
  baseSalary: number;
  /** 0..100 */
  morale: number;
  roomId: Id | null;
  hiredDay: number;
  lastRaiseDay: number;
  raisePending: boolean;
  /** day a pending raise was requested, or null */
  raiseRequestedDay: number | null;
  raiseGrantedDay: number | null;
  raiseRefusedDay: number | null;
  founder: boolean;
  hasLaptop: boolean;
}

export interface Candidate {
  id: Id;
  name: string;
  role: Role;
  archetype: Archetype;
  quirk: Quirk;
  skill: number;
  salary: number;
  /** one-line pitch shown on the card */
  pitch: string;
}

// ---------------------------------------------------------------- building
export type RoomKind = Role | 'garage' | 'lobby' | 'demo';
export type RoomSize = 'small' | 'large';

export interface Room {
  id: Id;
  kind: RoomKind;
  size: RoomSize;
  floor: 0 | 1;
  x: number;
  y: number;
  w: number;
  h: number;
  /** monthly */
  rent: number;
  openedDay: number;
}

// ---------------------------------------------------------------- assets
export type AssetKind = 'desk' | 'laptop' | 'server' | 'coffee' | 'demoRoom' | 'secondFloor';
export const ASSET_KINDS: readonly AssetKind[] = ['desk', 'laptop', 'server', 'coffee', 'demoRoom', 'secondFloor'];

export interface Asset {
  id: Id;
  kind: AssetKind;
  cost: number;
  bookValue: number;
  lifeMonths: number;
  boughtDay: number;
  /** desks: the room they stand in; demoRoom: the demo Room; else null */
  roomId: Id | null;
}

/** What the Invest panel shows for one catalogue entry. */
export interface AssetCard {
  kind: AssetKind;
  label: string;
  price: number;
  lifeMonths: number;
  monthlyDepreciation: number;
  /** plain words, e.g. "+1 seat in a room" */
  effect: string;
  /** estimated monthly cash benefit in $, 0 when not estimable */
  monthlyBenefit: number;
  /** months, null when benefit is 0 */
  paybackMonths: number | null;
  /** can the player buy it right now */
  verdict: Verdict;
}

// ---------------------------------------------------------------- customers
export type CustomerKind = 'smb' | 'enterprise';

export interface Customer {
  id: Id;
  kind: CustomerKind;
  joinedDay: number;
  /** smb: billed at month end. enterprise: contractValue/12, used for display and concentration */
  monthlyPrice: number;
  /** enterprise annual contract value; 0 for smb */
  contractValue: number;
  /** enterprise: day the contract ends (renewal decision); null for smb */
  contractEndDay: number | null;
  /** set by the "press them" choice: will not renew */
  noRenew: boolean;
  /** share of this customer's tickets served last month, 0..1 */
  servedShare: number;
}

export type InvoiceStatus = 'open' | 'paid' | 'writtenOff';

export interface Invoice {
  id: Id;
  customerId: Id;
  amount: number;
  issuedDay: number;
  dueDay: number;
  status: InvoiceStatus;
  settledDay: number | null;
  /** pushed back by the late-payer event */
  late: boolean;
}

/** An enterprise visitor waiting in the lobby for a sales rep. */
export interface Prospect {
  id: Id;
  arrivedDay: number;
  expiresDay: number;
  /** deal value if closed, fixed at arrival */
  value: number;
  repId: Id | null;
  /** 0..1, deal closes at 1 */
  progress: number;
}

// ---------------------------------------------------------------- money
export interface Loan {
  id: Id;
  principal: number;
  annualRate: number;
  startDay: number;
  dueDay: number;
  rolledOver: boolean;
}

export interface Round {
  day: number;
  amount: number;
  shareSold: number;
  preMoney: number;
  postMoney: number;
  desperate: boolean;
  /** the investor's name, for the cap table */
  fund: string;
}

export interface PnL {
  smbRevenue: number;
  enterpriseRevenue: number;
  salaries: number;
  rent: number;
  marketing: number;
  interest: number;
  depreciation: number;
  severance: number;
  badDebt: number;
  commission: number;
  disposalLoss: number;
  eventCosts: number;
}

export interface CashFlow {
  smbReceipts: number;
  collections: number;
  disposalProceeds: number;
  salaries: number;
  rent: number;
  marketing: number;
  interest: number;
  severance: number;
  commission: number;
  capex: number;
  eventCosts: number;
}

export interface Financing {
  equityIn: number;
  loanIn: number;
  loanRepaid: number;
}

export interface MonthBook {
  /** 0-based month index */
  month: number;
  startDay: number;
  pnl: PnL;
  cf: CashFlow;
  fin: Financing;
  cashStart: number;
  arStart: number;
  assetsBookStart: number;
  debtStart: number;
  // activity counters
  visitors: number;
  smbSignups: number;
  dealsSigned: number;
  churned: number;
  invoicesIssued: number;
  // filled at close
  closed: boolean;
  cashEnd: number;
  arEnd: number;
  assetsBookEnd: number;
  debtEnd: number;
  profit: number;
  fcf: number;
  deltaCash: number;
  customersEnd: number;
  featuresEnd: number;
  valueEnd: number;
  requiredReturnEnd: number;
}

export interface Premia {
  base: number;
  burn: number;
  rnd: number;
  leverage: number;
  concentration: number;
  recession: number;
}

export interface Valuation {
  /** equity value shown in the HUD */
  value: number;
  /** enterprise value from the forecast (can be negative) */
  dcf: number;
  /** equity value from operations only: max(0, dcf + cash − debt); what investors size offers on */
  operating: number;
  floor: number;
  /** the team part of the floor: min(Σ skill × acquihirePerSkill, acquihireCap) */
  acquihire: number;
  /** required return, annual */
  r: number;
  premia: Premia;
  /** monthly growth used for the forecast */
  growth: number;
  /** monthly operating cash flow after maintenance capex used as the base */
  runRate: number;
  /** null when not burning */
  runwayMonths: number | null;
}

// ---------------------------------------------------------------- cards
export type EventType = 'latePayer' | 'outage' | 'press' | 'competitor' | 'poach' | 'recession';
export const EVENT_TYPES: readonly EventType[] = ['latePayer', 'outage', 'press', 'competitor', 'poach', 'recession'];

export type CardKind = 'knock' | 'desperation' | 'maturity' | 'event' | 'gameOver' | 'sold';

export interface CardChoice {
  id: string;
  label: string;
  /** second line, e.g. "$2M for 24%" or "−$15k now" */
  detail: string;
  disabled?: boolean;
  reason?: string;
}

export interface Card {
  id: Id;
  kind: CardKind;
  eventType?: EventType;
  title: string;
  /** e.g. "A partner at Horizon Ventures" */
  speaker?: string;
  quote?: string;
  body: string;
  choices: CardChoice[];
  /** module-private payload (offer amounts, affected ids...) */
  data: Record<string, unknown>;
  createdDay: number;
}

// ---------------------------------------------------------------- effects & schedule
export interface Effects {
  /** feature count at which the competitor penalty ends, null when inactive */
  competitorUntilFeatures: number | null;
  pressUntilDay: number;
  pressMult: number;
  recessionUntilDay: number;
  priceCutUntilDay: number;
  salaryCutUntilDay: number;
}

export interface Schedule {
  nextKnockDay: number;
  nextEventDay: number;
  lastDesperationDay: number;
  /** a desperation knock was already offered in the current cash < 0 crisis */
  crisisKnockGiven: boolean;
  /** cash was < 0 at a close while a card was open: re-check after the card */
  pendingSolvencyCheck: boolean;
  /** investor cards opened so far, any kind */
  knocks: number;
  /**
   * The game day the round will end on, as the shell projects it from the countdown
   * (DESIGN.md 0: cards stop the game clock, not the countdown, so the buzzer rings before
   * the nominal RULES.roundMonths). null: the nominal round, or no round at all.
   */
  roundEndDay: number | null;
}

// ---------------------------------------------------------------- visuals & log
export type VisualEvent =
  | { t: 'visitor'; day: number; outcome: 'smb' | 'enterprise' | 'left' | 'waiting' }
  | { t: 'coins'; day: number; amount: number; source: 'smb' | 'collection' | 'deal' }
  | { t: 'invoice'; day: number; amount: number; dueDay: number }
  | { t: 'churn'; day: number; kind: CustomerKind }
  | { t: 'feature'; day: number; features: number }
  | { t: 'tier'; day: number; tier: number }
  | { t: 'hire'; day: number; personId: Id }
  | { t: 'leave'; day: number; personId: Id; name: string; reason: 'fired' | 'quit' | 'poached' | 'roomClosed' }
  | { t: 'room'; day: number; roomId: Id; op: 'open' | 'close' }
  | { t: 'asset'; day: number; kind: AssetKind; op: 'buy' | 'sell' }
  | { t: 'outage'; day: number }
  | { t: 'close'; day: number; month: number }
  | { t: 'toast'; day: number; text: string; tone: 'good' | 'bad' | 'info' };

export interface LogEntry {
  day: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
}

// ---------------------------------------------------------------- actions
export type Action =
  | { type: 'hire'; candidateId: Id }
  | { type: 'fire'; personId: Id }
  | { type: 'raise'; personId: Id; grant: boolean }
  | { type: 'founderRole'; role: 'product' | 'sales' }
  | { type: 'placeRoom'; kind: Role | 'demo'; size: RoomSize; floor: 0 | 1; x: number; y: number }
  | { type: 'closeRoom'; roomId: Id }
  | { type: 'buyAsset'; kind: AssetKind; roomId?: Id }
  | { type: 'sellAsset'; assetId: Id }
  | { type: 'setAdBudget'; amount: number }
  | { type: 'card'; choiceId: string }
  | { type: 'prepayLoan' }
  | { type: 'sell' }
  /** tournament actions (DESIGN.md 0): one fixed hire per department, auto-provisioned */
  | { type: 'hireRole'; role: Role }
  | { type: 'fireRole'; role: Role }
  | { type: 'buyDemoRoom' }
  | { type: 'timeUp' }
  | { type: 'debug'; op: 'cash' | 'knock' | 'event' | 'feature' | 'tenCustomers' };

export interface ActionRecord {
  day: number;
  action: Action;
}

export interface Verdict {
  ok: boolean;
  reason?: string;
}
export const OK: Verdict = { ok: true };
export const no = (reason: string): Verdict => ({ ok: false, reason });

// ---------------------------------------------------------------- result
export interface Result {
  kind: 'sold' | 'gameOver';
  day: number;
  offer: number;
  founderShare: number;
  debt: number;
  score: number;
  reason: string;
}

// ---------------------------------------------------------------- state
export type Status = 'playing' | 'gameOver' | 'sold';

export type RngState = [number, number, number, number];

export interface GameState {
  version: 1;
  seed: number;
  rng: RngState;
  /** game day, 0 at start; day N closes month when N % 30 === 0 */
  day: number;
  status: Status;
  companyName: string;

  cash: number;
  /** 0..1 */
  founderShare: number;
  loan: Loan | null;
  rounds: Round[];
  founderRole: 'product' | 'sales';

  people: Person[];
  candidates: Record<Role, Candidate[]>;
  nextId: number;

  rooms: Room[];
  floors: 1 | 2;
  assets: Asset[];

  customers: Customer[];
  invoices: Invoice[];
  prospects: Prospect[];

  features: number;
  featurePoints: number;
  tier: 1 | 2 | 3;
  researchPoints: number;
  /** monthly ad budget, $ */
  adBudget: number;
  /** share of tickets served over the last closed month, 0..1 */
  ticketsServedShare: number;

  /** month to date */
  book: MonthBook;
  history: MonthBook[];
  valuation: Valuation;
  /** one entry per closed month, newest last, capped at 60 */
  valueHistory: number[];

  effects: Effects;
  schedule: Schedule;
  financeUnlocked: boolean;

  card: Card | null;
  log: LogEntry[];
  /** queue for the renderer; drained by the UI */
  visuals: VisualEvent[];
  actions: ActionRecord[];
  result: Result | null;
}
