import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanFingerprint } from './fingerprintSimulator.js';

const claim = { studentId: 'stu-form3b-001', cardUid: '04A1B2C3' };

describe('scanFingerprint', () => {
  test('returns a well-formed result', () => {
    const r = scanFingerprint(claim, 0.9);
    assert.equal(r.studentId, claim.studentId);
    assert.equal(r.cardUid, claim.cardUid);
    assert.equal(typeof r.match, 'boolean');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.equal(r.successRate, 0.9);
    assert.ok(!Number.isNaN(Date.parse(r.scannedAt)));
  });

  test('successRate 1 always matches, 0 never matches', () => {
    for (let i = 0; i < 200; i++) {
      assert.equal(scanFingerprint(claim, 1).match, true);
      assert.equal(scanFingerprint(claim, 0).match, false);
    }
  });

  test('out-of-range successRate is clamped to [0, 1]', () => {
    assert.equal(scanFingerprint(claim, 5).match, true);
    assert.equal(scanFingerprint(claim, -1).match, false);
  });

  test('match rate tracks successRate over many scans', () => {
    const n = 4000;
    let matches = 0;
    for (let i = 0; i < n; i++) if (scanFingerprint(claim, 0.7).match) matches++;
    const rate = matches / n;
    assert.ok(rate > 0.6 && rate < 0.8, `expected ~0.70, got ${rate.toFixed(3)}`);
  });

  test('a match reports higher confidence than a no-match', () => {
    const matches = [];
    const noMatches = [];
    while (matches.length < 30 || noMatches.length < 30) {
      const r = scanFingerprint(claim, 0.5);
      (r.match ? matches : noMatches).push(r.confidence);
    }
    assert.ok(Math.min(...matches) >= 0.75);
    assert.ok(Math.max(...noMatches) < 0.5);
  });
});
