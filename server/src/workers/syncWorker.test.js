'use strict';

process.env.SQLITE_PATH = ':memory:';
process.env.SYNC_WORKER_DISABLED = 'true';
process.env.SYNC_BACKOFF_MIN_MS = '60000';
process.env.SYNC_BACKOFF_MAX_MS = '1800000';

const { backoffMs, chunk, acceptedEventIds } = require('./syncWorker');

describe('syncWorker helpers', () => {
  test('exponential backoff starts at 60s, doubles, caps at 30min', () => {
    expect(backoffMs(0)).toBe(60_000); // first failure -> 60s
    expect(backoffMs(1)).toBe(120_000);
    expect(backoffMs(2)).toBe(240_000);
    expect(backoffMs(3)).toBe(480_000);
    expect(backoffMs(4)).toBe(960_000);
    expect(backoffMs(5)).toBe(1_800_000); // 1920s clamped to 30min
    expect(backoffMs(20)).toBe(1_800_000);
  });

  test('chunk splits into batches of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
  });

  test('acceptedEventIds unions inserted + skipped from the cloud response', () => {
    const records = [{ eventId: 'a' }, { eventId: 'b' }, { eventId: 'c' }];
    const body = { inserted: ['a'], skipped: [{ eventId: 'b', reason: 'duplicate_event_id' }] };
    expect([...acceptedEventIds(records, body)].sort()).toEqual(['a', 'b']);
  });

  test('acceptedEventIds treats a bare 2xx (no detail) as whole-batch success', () => {
    const records = [{ eventId: 'a' }, { eventId: 'b' }];
    expect([...acceptedEventIds(records, {})].sort()).toEqual(['a', 'b']);
  });
});
