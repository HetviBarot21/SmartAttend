import { randomInt } from 'node:crypto';

// The brief asked for `crypto.randomFloat`. Node has no such function - the
// closest primitives are crypto.randomInt() and crypto.randomBytes(). This is
// the equivalent: a cryptographically-seeded uniform double in [0, 1), with the
// same shape of use as Math.random() but not predictable.
const RESOLUTION = 2 ** 32;

/** Uniform random double in [0, 1), backed by the CSPRNG. */
export function randomFloat() {
  return randomInt(0, RESOLUTION) / RESOLUTION;
}

/**
 * True with probability `p`. `chance(0.25)` is true roughly one time in four.
 * p <= 0 is always false, p >= 1 is always true.
 */
export function chance(p) {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return randomFloat() < p;
}

/** A uniformly random element of a non-empty array. */
export function pick(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('pick() needs a non-empty array');
  }
  return items[randomInt(0, items.length)];
}
