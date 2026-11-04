/**
 * The Playbook page (DESIGN.md 18): the scaling sequence and one section per decision,
 * every number generated from CONFIG/RULES. STUB — to be implemented.
 */
export interface PlaybookSection {
  title: string;
  paragraphs: string[];
}

export function playbookSections(): PlaybookSection[] {
  return [];
}

export interface PlaybookHandle {
  close(): void;
}

/** Opens the Playbook as a full-column sheet over root; the clock keeps running. */
export function openPlaybook(root: HTMLElement): PlaybookHandle {
  void root;
  return { close() {} };
}
