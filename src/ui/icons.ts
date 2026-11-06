/**
 * The inline-SVG icon set (DESIGN.md 17): one 24px grid, 2px rounded strokes, every
 * stroke in currentColor so an icon takes the colour of the text around it. Each
 * function returns a fresh SVGElement (an element can only live in one place in the
 * DOM). Decorative by default (aria-hidden); pass a label when the icon stands alone.
 */
import { svg } from './panels/dom';

export type IconName =
  | 'cash' | 'trendUp' | 'trendDown' | 'bars' | 'building' | 'pie'
  | 'personPlus' | 'personMinus'
  | 'wrench' | 'handshake' | 'headset' | 'megaphone' | 'briefcase' | 'flask'
  | 'server' | 'screen' | 'coin' | 'calendar' | 'gear'
  | 'speakerOn' | 'speakerOff' | 'question' | 'play' | 'pause' | 'copy' | 'trophy' | 'flag';

/** Path data per icon: each entry becomes one <path d>; a short "h.01" is a round-capped dot. */
const PATHS: Record<IconName, string[]> = {
  cash: [
    'M4 9.5h16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-7A1.5 1.5 0 0 1 4 9.5z',
    'M12 17.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M5 6.5h14',
    'M7.5 3.5h9',
  ],
  trendUp: ['M3 17l6-6 4 4 8-8', 'M14 7h7v7'],
  trendDown: ['M3 7l6 6 4-4 8 8', 'M14 17h7v-7'],
  bars: ['M6 20v-7', 'M12 20V5', 'M18 20v-10', 'M3 20h18'],
  building: [
    'M5 21V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V21',
    'M3 21h18',
    'M9 7h2', 'M13 7h2', 'M9 11h2', 'M13 11h2', 'M9 15h2', 'M13 15h2',
    'M10 21v-3h4v3',
  ],
  pie: ['M12 3a9 9 0 1 0 9 9', 'M12 3v9h9', 'M21 12a9 9 0 0 0-9-9'],
  personPlus: ['M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2.5 21v-1.5A4.5 4.5 0 0 1 7 15h4a4.5 4.5 0 0 1 4.5 4.5V21', 'M19 8v6', 'M16 11h6'],
  personMinus: ['M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2.5 21v-1.5A4.5 4.5 0 0 1 7 15h4a4.5 4.5 0 0 1 4.5 4.5V21', 'M16 11h6'],
  wrench: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ],
  handshake: [
    'M2 10.5l3.5-4h4l2.5 2.5 2.5-2.5h4l3.5 4',
    'M7.5 13l3 3a1.6 1.6 0 0 0 2.3-2.3L12 13',
    'M10.5 16l2 2a1.6 1.6 0 0 0 2.3-2.3',
    'M13.5 18.5l.8.8a1.6 1.6 0 0 0 2.3-2.3l-2.1-2.1',
    'M12 9l-3 3',
  ],
  headset: [
    'M4 15v-3a8 8 0 0 1 16 0v3',
    'M3.5 14h2A1.5 1.5 0 0 1 7 15.5v3A1.5 1.5 0 0 1 5.5 20h-2A1.5 1.5 0 0 1 2 18.5v-3A1.5 1.5 0 0 1 3.5 14z',
    'M18.5 14h2a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5z',
    'M20 20a3 3 0 0 1-3 3h-3',
  ],
  megaphone: [
    'M3 10.5v3A1.5 1.5 0 0 0 4.5 15H8l9.5 4.5v-15L8 9H4.5A1.5 1.5 0 0 0 3 10.5z',
    'M20.5 9.5a4.5 4.5 0 0 1 0 5',
    'M8 15l1 5.5h3',
  ],
  briefcase: [
    'M3.5 7.5h17A1.5 1.5 0 0 1 22 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5V9a1.5 1.5 0 0 1 1.5-1.5z',
    'M8 7.5V5a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 5v2.5',
    'M2 12.5h20',
  ],
  flask: ['M9 3h6', 'M10 3v6l-5.5 9.5A1.5 1.5 0 0 0 5.8 21h12.4a1.5 1.5 0 0 0 1.3-2.5L14 9V3', 'M7.5 15h9'],
  server: [
    'M4 4h16a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 20 10H4a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 4 4z',
    'M4 14h16a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 4 14z',
    'M6.5 7h.01', 'M6.5 17h.01',
  ],
  screen: ['M4 4h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 16H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 4z', 'M8 20.5h8', 'M12 16v4.5'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 6.5v11', 'M14.5 9.5h-3.5a1.75 1.75 0 0 0 0 3.5h2a1.75 1.75 0 0 1 0 3.5H9.5'],
  calendar: ['M4.5 5h15A1.5 1.5 0 0 1 21 6.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-13A1.5 1.5 0 0 1 4.5 5z', 'M3 10h18', 'M8 3v4', 'M16 3v4'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
  speakerOn: ['M11 5L6 9H2.5v6H6l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  speakerOff: ['M11 5L6 9H2.5v6H6l5 4V5z', 'M22 9l-6 6', 'M16 9l6 6'],
  question: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
  play: ['M6.5 4.5v15a.5.5 0 0 0 .77.42l12-7.5a.5.5 0 0 0 0-.84l-12-7.5a.5.5 0 0 0-.77.42z'],
  pause: ['M7 4.5h3v15H7z', 'M14 4.5h3v15h-3z'],
  copy: ['M10.5 9.5h10A1.5 1.5 0 0 1 22 11v10a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 9 21V11a1.5 1.5 0 0 1 1.5-1.5z', 'M5 15H3.5A1.5 1.5 0 0 1 2 13.5v-10A1.5 1.5 0 0 1 3.5 2h10A1.5 1.5 0 0 1 15 3.5V5'],
  trophy: ['M6.5 3.5h11V9a5.5 5.5 0 0 1-11 0z', 'M6.5 5.5H4a1.75 1.75 0 0 0 0 3.5h2.5', 'M17.5 5.5H20a1.75 1.75 0 0 1 0 3.5h-2.5', 'M12 14.5v4', 'M8 20.5h8'],
  flag: ['M4.5 21.5V3.5', 'M4.5 4.5c2-1.3 4-1.3 6 0s4 1.3 6 0 3-1 3-1v9s-1 .7-3 1-4-1.3-6-2.6-4-1.3-6 0'],
};

/** Human names for the `title` of a standalone icon. */
const LABEL: Record<IconName, string> = {
  cash: 'Cash', trendUp: 'Up', trendDown: 'Down', bars: 'Cash flow', building: 'Company value', pie: 'Your stake',
  personPlus: 'Hire', personMinus: 'Let go',
  wrench: 'Product', handshake: 'Sales', headset: 'Support', megaphone: 'Marketing', briefcase: 'Finance', flask: 'R&D',
  server: 'Server', screen: 'Demo room', coin: 'Coin', calendar: 'Calendar', gear: 'Settings',
  speakerOn: 'Sound on', speakerOff: 'Sound off', question: 'Help', play: 'Play', pause: 'Pause', copy: 'Copy', trophy: 'Coach', flag: 'Finish',
};

export interface IconOptions {
  /** extra class on the <svg>, next to "icon" and "icon-<name>" */
  class?: string;
  /** an accessible name; without one the icon is decorative (aria-hidden) */
  label?: string;
  /** CSS size, default 1em so the icon follows the font size */
  size?: string;
}

/** One icon as a fresh <svg>: 24×24 viewBox, 2px rounded strokes, currentColor. */
export function icon(name: IconName, opts: IconOptions = {}): SVGSVGElement {
  const el = svg('svg', {
    class: `icon icon-${name}${opts.class ? ` ${opts.class}` : ''}`,
    viewBox: '0 0 24 24',
    width: opts.size ?? '1em',
    height: opts.size ?? '1em',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  });
  if (opts.label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', opts.label);
    el.appendChild(svg('title', {}, opts.label));
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  for (const d of PATHS[name]) el.appendChild(svg('path', { d }));
  return el;
}

export function iconLabel(name: IconName): string {
  return LABEL[name];
}

/** The department icons of DESIGN.md 17 (Finance and R&D exist for the engine's sake). */
export const ROLE_ICON = {
  product: 'wrench', sales: 'handshake', support: 'headset', marketing: 'megaphone', finance: 'briefcase', rnd: 'flask',
} as const satisfies Record<'product' | 'sales' | 'support' | 'marketing' | 'finance' | 'rnd', IconName>;

export const ICON_NAMES: readonly IconName[] = Object.keys(PATHS) as IconName[];

// one function per icon, for callers that prefer a name over a string
export const iconCash = (): SVGElement => icon('cash');
export const iconTrendUp = (): SVGElement => icon('trendUp');
export const iconTrendDown = (): SVGElement => icon('trendDown');
export const iconBars = (): SVGElement => icon('bars');
export const iconBuilding = (): SVGElement => icon('building');
export const iconPie = (): SVGElement => icon('pie');
export const iconPersonPlus = (): SVGElement => icon('personPlus');
export const iconPersonMinus = (): SVGElement => icon('personMinus');
export const iconWrench = (): SVGElement => icon('wrench');
export const iconHandshake = (): SVGElement => icon('handshake');
export const iconHeadset = (): SVGElement => icon('headset');
export const iconMegaphone = (): SVGElement => icon('megaphone');
export const iconServer = (): SVGElement => icon('server');
export const iconScreen = (): SVGElement => icon('screen');
export const iconCoin = (): SVGElement => icon('coin');
export const iconCalendar = (): SVGElement => icon('calendar');
export const iconGear = (): SVGElement => icon('gear');
export const iconSpeakerOn = (): SVGElement => icon('speakerOn');
export const iconSpeakerOff = (): SVGElement => icon('speakerOff');
export const iconQuestion = (): SVGElement => icon('question');
export const iconPlay = (): SVGElement => icon('play');
export const iconCopy = (): SVGElement => icon('copy');
export const iconTrophy = (): SVGElement => icon('trophy');
export const iconFlag = (): SVGElement => icon('flag');
