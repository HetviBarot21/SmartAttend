import { chance, randomFloat } from '../lib/random.js';
import { config } from '../config.js';

/**
 * Mock fingerprint scanner.
 *
 * There is no hardware in the Friday build, so a "scan" is a coin flip weighted
 * by a configurable success rate. `successRate` is the probability the presented
 * finger is accepted as the claimed student - i.e. the chance an honest student
 * passes. A low rate models a dirty sensor or a wet thumb; a failed match on an
 * honest student is a false reject, a passed match on an impostor is the
 * buddy-punching case the challenge exists to catch.
 *
 * @param {object}  claim
 * @param {string}  claim.studentId   student the RFID card claims to be
 * @param {string} [claim.cardUid]
 * @param {number} [successRate]      override config.fingerprintSuccessRate (0..1)
 * @returns {{ studentId: string, cardUid: string|null, match: boolean,
 *             confidence: number, successRate: number, scannedAt: string }}
 */
export function scanFingerprint(claim = {}, successRate = config.fingerprintSuccessRate) {
  const rate = clamp01(successRate);
  const match = chance(rate);

  // A plausible-looking confidence score for logs/UI: high band on a match,
  // low band on a no-match. Nothing downstream depends on the exact number.
  const confidence = match
    ? round(0.75 + randomFloat() * 0.25)
    : round(randomFloat() * 0.45);

  return {
    studentId: claim.studentId ?? null,
    cardUid: claim.cardUid ?? null,
    match,
    confidence,
    successRate: rate,
    scannedAt: new Date().toISOString(),
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

const round = (n) => Math.round(n * 100) / 100;
