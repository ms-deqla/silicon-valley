/**
 * Street life maths (DESIGN 17): the bus that crosses the road every so often.
 * Pure functions of the renderer's wall-clock time, so nothing is stored per
 * frame and the unit tests can drive them without a DOM.
 */

/** seconds between bus crossings */
export const BUS_PERIOD = 40;
/** seconds a crossing takes, edge to edge */
export const BUS_CROSS = 5.5;

/** 0..1 while a bus is crossing, −1 otherwise. */
export function busProgress(time: number): number {
  if (!(time >= 0)) return -1;
  const phase = time % BUS_PERIOD;
  return phase < BUS_CROSS ? phase / BUS_CROSS : -1;
}

/** Crossings alternate direction: +1 drives left to right. */
export function busDir(time: number): 1 | -1 {
  return Math.floor(Math.max(0, time) / BUS_PERIOD) % 2 === 0 ? 1 : -1;
}

/** The bus's x for a crossing: it starts fully off one edge and ends fully off the other. */
export function busX(progress: number, dir: 1 | -1, width: number, busW: number): number {
  const from = dir > 0 ? -busW : width + busW;
  const to = dir > 0 ? width + busW : -busW;
  return from + (to - from) * progress;
}
