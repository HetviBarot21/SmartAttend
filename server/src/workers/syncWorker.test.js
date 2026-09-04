import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// syncWorker opens a DB connection at import time; keep it in memory for tests.
process.env.DB_PATH = ':memory:';

const { backoffMs, chunk, acceptedEventIds } = await import('./syncWorker.js');

describe('syncWorker helpers', () => {
  test('exponential backoff starts at 60s, doubles, caps at 30min', () => {
    assert.equal(backoffMs(0), 60_000); // first failure -> 60s
    assert.equal(backoffMs(1), 120_000);
    assert.equal(backoffMs(2), 240_000);
    assert.equal(backoffMs(3), 480_000);
    assert.equal(backoffMs(4), 960_000);
    assert.equal(backoffMs(5), 1_800_000); // 1920s clamped to 30min
    assert.equal(backoffMs(20), 1_800_000);
  });

  test('chunk splits into batches of the given size', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 50), []);
  });

  test('acceptedEventIds unions inserted + skipped from the cloud response', () => {
    const records = [{ eventId: 'a' }, { eventId: 'b' }, { eventId: 'c' }];
    const body = { inserted: ['a'], skipped: [{ eventId: 'b', reason: 'duplicate_event_id' }] };
    assert.deepEqual([...acceptedEventIds(records, body)].sort(), ['a', 'b']);
  });

  test('acceptedEventIds treats a bare 2xx (no detail) as whole-batch success', () => {
    const records = [{ eventId: 'a' }, { eventId: 'b' }];
    assert.deepEqual([...acceptedEventIds(records, {})].sort(), ['a', 'b']);
  });
});
