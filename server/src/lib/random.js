import { randomInt } from 'node:crypto';

const RESOLUTION = 2 ** 32;

/** Uniform random double in [0, 1), backed by the CSPRNG. */
export function randomFloat() {
  return randomInt(0, RESOLUTION) / RESOLUTION;
}

/** True with probability `p`. */
export function chance(p) {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return randomFloat() < p;
}

export function pick(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('pick() needs a non-empty array');
  }
  return items[randomInt(0, items.length)];
}
