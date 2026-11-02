/**
 * DESIGN.md section 3, the art register: department colours and the pastel tints
 * derived from them. Everything here is cosmetic and precomputed once so the
 * painter never builds colour strings per frame.
 */
import { ROLE_LABEL } from '../../sim/types';
import type { Role, RoomKind } from '../../sim/types';

export const DEPT: Record<Role, string> = {
  product: '#5B8DEF',
  sales: '#5FBF7A',
  support: '#F2A94A',
  marketing: '#A77BEF',
  finance: '#4FB9C9',
  rnd: '#6C6FD8',
};

export const ROOM_BASE: Record<RoomKind, string> = {
  ...DEPT,
  lobby: '#F28CB1',
  garage: '#C9BFB2',
  demo: '#8FA7C9',
};

export const ROOM_NAME: Record<RoomKind, string> = {
  ...ROLE_LABEL,
  lobby: 'Lobby',
  garage: 'Garage',
  demo: 'Demo',
};

export const WOOD = '#E8D7BE';
export const STREET = '#B8BDC4';
export const GRASS = '#A9D68B';
export const INK = '#2B2F3A';
export const GOLD = '#F5B300';
export const PAVEMENT = '#DBD8D2';
export const PAVEMENT_LIGHT = '#E6E3DE';
export const KERB = '#B6B2AB';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function hex2(v: number): string {
  const s = Math.round(Math.max(0, Math.min(255, v))).toString(16);
  return s.length === 1 ? '0' + s : s;
}

/** Mix two hex colours: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return `#${hex2(ar + (br - ar) * t)}${hex2(ag + (bg - ag) * t)}${hex2(ab + (bb - ab) * t)}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function derive(f: (base: string, kind: RoomKind) => string): Record<RoomKind, string> {
  const out = {} as Record<RoomKind, string>;
  for (const k of Object.keys(ROOM_BASE) as RoomKind[]) out[k] = f(ROOM_BASE[k], k);
  return out;
}

/** pastel floor by kind */
export const ROOM_FLOOR = derive((b, k) => mix(b, '#FFFFFF', k === 'garage' ? 0.42 : 0.64));
/** back wall: lighter than the floor */
export const ROOM_BACK = derive((b, k) => mix(b, '#FFFFFF', k === 'garage' ? 0.62 : 0.80));
/** side walls: a touch deeper than the floor */
export const ROOM_SIDE = derive((b, k) => mix(b, '#FFFFFF', k === 'garage' ? 0.25 : 0.46));
/** outline */
export const ROOM_EDGE = derive((b) => withAlpha(mix(b, '#2E3448', 0.45), 0.55));
/** selection / tier glow */
export const ROOM_GLOW = derive((b) => withAlpha(b, 0.55));
/** placement ghost */
export const ROOM_GHOST = derive((b) => withAlpha(b, 0.45));

export const SKIN = ['#F7D7BE', '#EDBD98', '#C98F66', '#8E5C3B'];
export const HAIR = ['#3B2A1E', '#6B4A2B', '#C47A2E', '#2B2B33', '#D9A441', '#7A4B8C'];

export const WALKER_BODY = {
  smb: '#F2C14E',
  enterprise: '#4A5B7D',
  left: '#B9BEC6',
  waiting: '#6F7E9C',
  churn: '#C3C6CF',
} as const;

/** confetti colours: the six department colours */
export const CONFETTI: readonly string[] = [DEPT.product, DEPT.sales, DEPT.support, DEPT.marketing, DEPT.finance, DEPT.rnd];
