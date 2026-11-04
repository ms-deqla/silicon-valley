/**
 * Music and effects (DESIGN.md 19), Web Audio only. STUB — to be implemented.
 */
export type Sfx = 'coin' | 'knock' | 'page' | 'buzzer' | 'click';

export interface Audio {
  /** false when an AudioContext cannot be created: hide the button */
  readonly available: boolean;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  /** call from a user gesture (the Start tap); starts the loop when enabled */
  start(): void;
  play(sfx: Sfx): void;
  destroy(): void;
}

export function createAudio(): Audio {
  let enabled = false;
  return {
    available: false,
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; },
    start() {},
    play() {},
    destroy() {},
  };
}
