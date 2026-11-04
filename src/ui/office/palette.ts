/**
 * DESIGN.md section 3, the art register, and the section 17 accents: department
 * colours, the pastel tints derived from them, the figure palettes and the few
 * colours the floor feedback uses. Everything here is cosmetic and precomputed
 * once so the painter never builds colour strings per frame.
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
export const GRASS_LIGHT = '#B9DF9F';
export const GRASS_DARK = '#9CCB80';
export const INK = '#2B2F3A';
export const GOLD = '#F5B300';
/** the warm lot pavement and its lighter tile (every other cell) */
export const LOT = '#E5DDD0';
export const LOT_LIGHT = '#EAE3D7';
export const PAVEMENT = '#DBD5CB';
export const PAVEMENT_LIGHT = '#E9E4DB';
export const KERB = '#C3BDB2';
/** the cream the room floors are tinted over */
export const CREAM = '#FBF7EE';

/** DESIGN 17 accents on the floor: money in (coin pills), the invoice line, the build plots */
export const MONEY_GREEN = '#22C55E';
export const MONEY_GREEN_DARK = '#15803D';
export const LINE_BLUE = '#3B82F6';
export const BUILD_AMBER = '#F59E0B';
/** the glass storey (DESIGN 0: the second floor): translucent walls and slab, a railing along its edge */
export const GLASS_SLAB = 'rgba(222,238,250,0.9)';
export const GLASS_WALL = 'rgba(196,224,246,0.6)';
export const GLASS_EDGE = 'rgba(110,160,210,0.75)';
export const GLASS_SHEEN = 'rgba(255,255,255,0.55)';
export const RAIL = '#8FA6BC';
/** windows on the back walls and the lamps */
export const SKY = '#BFE0F7';
export const SKY_LIGHT = '#E6F3FC';
export const WINDOW_FRAME = '#F7F4EE';
export const LAMP_SHADE = '#F2E6CC';
export const LAMP_POLE = '#8E8A82';
export const LAMP_LIGHT = 'rgba(255,214,120,0.32)';
export const LAMP_BULB = '#FFE9A8';
/** the brand plaque in the lobby: the four logo squares */
export const LOGO: readonly string[] = [DEPT.product, DEPT.support, DEPT.sales, DEPT.marketing];

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

/** floor: ~35% department colour over a cream base (the garage keeps more of its warm grey) */
export const ROOM_FLOOR = derive((b, k) => mix(CREAM, b, k === 'garage' ? 0.55 : 0.35));
/** back wall: a lighter tint than the floor */
export const ROOM_BACK = derive((b, k) => mix(b, '#FFFFFF', k === 'garage' ? 0.6 : 0.76));
/** side walls: thin strips a touch deeper than the floor */
export const ROOM_SIDE = derive((b, k) => mix(b, '#FFFFFF', k === 'garage' ? 0.22 : 0.4));
/** the lighter band along the top of the walls: the wall's top surface, lit from above (DESIGN 17) */
export const ROOM_TOP = derive((b, k) => mix(b, '#FFFFFF', k === 'garage' ? 0.72 : 0.9));
/** outline */
export const ROOM_EDGE = derive((b) => withAlpha(mix(b, '#2E3448', 0.45), 0.5));
/** selection / tier glow */
export const ROOM_GLOW = derive((b) => withAlpha(b, 0.55));
/** placement ghost */
export const ROOM_GHOST = derive((b) => withAlpha(b, 0.45));

/** five skin tones and six hair colours, hashed per person (DESIGN 3: big-headed pastel figures) */
export const SKIN = ['#F7D7BE', '#EDBD98', '#D9A077', '#B07A52', '#8E5C3B'];
export const HAIR = ['#3B2A1E', '#6B4A2B', '#C47A2E', '#2B2B33', '#D9A441', '#7A4B8C'];
/** trousers, hashed per figure */
export const TROUSERS = ['#3F4556', '#55607A', '#6E5F50', '#2F3A4F'];

/** visitors wear neutral blues and greys; staff wear their department colour */
export const WALKER_BODY = {
  smb: '#7FA5D8',
  enterprise: '#3F4C6B',
  left: '#A9AEB8',
  waiting: '#60728F',
  churn: '#B4B8C1',
} as const;
/** a few shirt blues so a crowd of SMB visitors is not one colour */
export const SMB_SHIRTS: readonly string[] = ['#7FA5D8', '#6A91C7', '#93B5E0', '#8A9BB5'];

/** confetti colours: the six department colours */
export const CONFETTI: readonly string[] = [DEPT.product, DEPT.sales, DEPT.support, DEPT.marketing, DEPT.finance, DEPT.rnd];

export interface Shades {
  light: string;
  dark: string;
}

const SHADES = new Map<string, Shades>();

/** Lighter and darker versions of an outfit colour, computed once per colour (outfit details never build strings per frame). */
export function shades(color: string): Shades {
  let s = SHADES.get(color);
  if (!s) {
    s = { light: mix(color, '#FFFFFF', 0.4), dark: mix(color, '#2E3448', 0.28) };
    SHADES.set(color, s);
  }
  return s;
}
