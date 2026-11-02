/**
 * Cosmetic text for the people, building and asset modules: candidate name
 * lists, the words a pitch uses for archetypes, jobs and quirks, room names for
 * log lines and a money formatter. No game rule lives here; every number that
 * appears in a pitch is read from CONFIG.
 */
import type { Archetype, Quirk, Role, RoomKind } from './types';
import { ROLE_LABEL } from './types';
import { CONFIG } from './config';

export const FIRST_NAMES: readonly string[] = [
  'Ada', 'Ben', 'Carla', 'Dev', 'Elin', 'Farid', 'Greta', 'Hugo', 'Ines', 'Jonas',
  'Kira', 'Leo', 'Maya', 'Nico', 'Olga', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tomas',
  'Uma', 'Vera', 'Wen', 'Xavi', 'Yara', 'Zane', 'Amir', 'Bea', 'Cole', 'Dana',
  'Emil', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lena', 'Milo', 'Nora',
];

export const LAST_NAMES: readonly string[] = [
  'Adler', 'Bauer', 'Chen', 'Dubois', 'Ekman', 'Fischer', 'Garcia', 'Haddad', 'Ivanova', 'Jensen',
  'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quist', 'Rossi', 'Santos', 'Tanaka',
  'Ueda', 'Vogel', 'Weber', 'Xu', 'Yilmaz', 'Zhang', 'Abbott', 'Berg', 'Costa', 'Dimitrov',
  'Eriksen', 'Ferreira', 'Grant', 'Holm', 'Ibarra', 'Jung', 'Kane', 'Lund', 'Marsh', 'Novak',
];

export const ARCHETYPE_WORD: Record<Archetype, string> = {
  junior: 'Junior', mid: 'Mid-level', senior: 'Senior', star: 'Star',
};

/** Lower-case job word for sentences ("a senior engineer"). */
export const JOB_WORD: Record<Role, string> = {
  product: 'engineer', sales: 'sales rep', support: 'support agent', marketing: 'marketer',
  finance: 'finance specialist', rnd: 'researcher',
};

/** The plain word every pitch for that quirk contains (tests look for it). */
export const QUIRK_WORD: Record<Quirk, string> = {
  coffee: 'coffee', crowd: 'crowded', mentor: 'mentor', mercenary: 'mercenary', loyal: 'loyal', diva: 'diva',
};

export const QUIRK_PITCH: Record<Quirk, string> = {
  coffee: 'Runs on coffee: unhappy without a coffee machine.',
  crowd: 'Hates a crowded room.',
  mentor: `A natural mentor: juniors in the same room learn ${CONFIG.people.mentorMult}× as fast.`,
  mercenary: `A mercenary at heart: walks out once morale drops below ${CONFIG.people.morale.mercenaryQuitBelow}.`,
  loyal: 'Loyal to the end: will never quit on you.',
  diva: `A bit of a diva: asks for a raise every ${CONFIG.people.divaRaiseEveryMonths} months.`,
};

export function roomName(kind: RoomKind): string {
  switch (kind) {
    case 'garage': return 'garage';
    case 'lobby': return 'lobby';
    case 'demo': return 'demo room';
    default: return `${ROLE_LABEL[kind]} room`;
  }
}

/** "$12,345"; rounds to whole dollars. */
export function fmtMoney(n: number): string {
  const sign = n < 0 ? '-' : '';
  const digits = Math.round(Math.abs(n)).toString();
  return `${sign}$${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
