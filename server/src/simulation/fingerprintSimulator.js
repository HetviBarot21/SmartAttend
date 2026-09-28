import { chance, randomFloat } from '../lib/random.js';
import { config } from '../config.js';

/**
 * Mock fingerprint scanner: a match with probability `successRate`.
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

  // Display only.
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
