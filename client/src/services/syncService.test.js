import { db, addAttendanceEvent } from '../db/database';
import { drainSyncQueue, backoffMs, RETRY_BASE_MS, RETRY_MAX_MS } from './syncService';

const DATE = '2026-08-27';

// fake-indexeddb persists for the whole process, so rebuild the DB per test.
beforeEach(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
  await db.open();
});

afterAll(async () => {
  if (db.isOpen()) db.close();
  await db.delete();
});

/** A fetch stub that resolves once with the given JSON body. */
function fetchReturning(payload, { ok = true, status = 200 } = {}) {
  return jest.fn().mockResolvedValue({ ok, status, json: async () => payload });
}

describe('drainSyncQueue', () => {
  it('marks a pending record as synced after a successful POST', async () => {
    const record = await addAttendanceEvent({
      studentId: 'stu-1',
      date: DATE,
      status: 'present',
      recordedBy: 'teacher.a',
    });

    expect((await db.syncQueue.where('eventId').equals(record.eventId).first()).status).toBe('pending');

    const fetchImpl = fetchReturning({ inserted: [record.eventId], skipped: [] });
    const summary = await drainSyncQueue({ deviceId: 'device-1', fetchImpl });

    // Posted the queued record to the sync endpoint, once.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/sync');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.deviceId).toBe('device-1');
    expect(body.records).toEqual([
      {
        eventId: record.eventId,
        studentId: 'stu-1',
        date: DATE,
        status: 'present',
        captureMethod: 'manual',
        recordedBy: 'teacher.a',
        createdAt: record.createdAt,
      },
    ]);

    // Queue row flipped to synced...
    const queued = await db.syncQueue.where('eventId').equals(record.eventId).first();
    expect(queued.status).toBe('synced');
    expect(queued.syncedAt).toEqual(expect.any(String));

    // ...and the attendance record is stamped too.
    const stored = await db.attendanceEvents.where('eventId').equals(record.eventId).first();
    expect(stored.syncedAt).toEqual(expect.any(String));

    expect(summary).toMatchObject({ eligible: 1, synced: 1, failed: 0 });
  });

  it('treats a server dedupe skip as settled, not a failure', async () => {
    const record = await addAttendanceEvent({ studentId: 'stu-2', date: DATE, status: 'absent' });
    const fetchImpl = fetchReturning({
      inserted: [],
      skipped: [{ eventId: record.eventId, reason: 'duplicate_event_id' }],
    });

    await drainSyncQueue({ fetchImpl });

    const queued = await db.syncQueue.where('eventId').equals(record.eventId).first();
    expect(queued.status).toBe('synced');
  });

  it('marks the record failed and schedules an exponential backoff on a transport error', async () => {
    const record = await addAttendanceEvent({ studentId: 'stu-3', date: DATE, status: 'late' });
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down'));

    const summary = await drainSyncQueue({ fetchImpl, now: () => 1_000_000 });

    const queued = await db.syncQueue.where('eventId').equals(record.eventId).first();
    expect(queued.status).toBe('failed');
    expect(queued.attemptCount).toBe(1);
    expect(queued.nextAttemptAt).toBe(1_000_000 + backoffMs(1));
    expect(queued.lastError).toMatch(/network down/);
    expect(summary).toMatchObject({ synced: 0, failed: 1 });
  });

  it('holds a failed record until its backoff window has passed, then syncs it', async () => {
    const record = await addAttendanceEvent({ studentId: 'stu-4', date: DATE, status: 'present' });

    const failing = jest.fn().mockRejectedValue(new Error('offline'));
    await drainSyncQueue({ fetchImpl: failing, now: () => 0 }); // nextAttemptAt = 60_000

    const tooSoon = fetchReturning({ inserted: [record.eventId], skipped: [] });
    const held = await drainSyncQueue({ fetchImpl: tooSoon, now: () => 30_000 });
    expect(tooSoon).not.toHaveBeenCalled();
    expect(held).toMatchObject({ eligible: 0, deferred: 1 });

    const later = fetchReturning({ inserted: [record.eventId], skipped: [] });
    await drainSyncQueue({ fetchImpl: later, now: () => 120_000 });
    expect(later).toHaveBeenCalledTimes(1);
    expect((await db.syncQueue.where('eventId').equals(record.eventId).first()).status).toBe('synced');
  });

  it('batches large backlogs into separate POSTs', async () => {
    for (let i = 0; i < 5; i += 1) {
      await addAttendanceEvent({ studentId: `stu-${i}`, date: DATE, status: 'present' });
    }
    const eventIds = (await db.attendanceEvents.toArray()).map((e) => e.eventId);
    const fetchImpl = jest.fn().mockImplementation((_url, init) => {
      const sent = JSON.parse(init.body).records.map((r) => r.eventId);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ inserted: sent, skipped: [] }) });
    });

    const summary = await drainSyncQueue({ fetchImpl, batchSize: 2 });

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 2 + 2 + 1
    expect(summary).toMatchObject({ synced: 5, failed: 0, batches: 3 });
    const stillPending = await db.syncQueue.where('status').anyOf('pending', 'failed').count();
    expect(stillPending).toBe(0);
    expect(eventIds).toHaveLength(5);
  });

  it('is a no-op when nothing is queued', async () => {
    const fetchImpl = jest.fn();
    const summary = await drainSyncQueue({ fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ eligible: 0, synced: 0, failed: 0 });
  });
});

describe('backoffMs', () => {
  it('doubles each attempt from the base and caps at the ceiling', () => {
    expect(backoffMs(1)).toBe(RETRY_BASE_MS);
    expect(backoffMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(backoffMs(3)).toBe(RETRY_BASE_MS * 4);
    expect(backoffMs(99)).toBe(RETRY_MAX_MS);
  });

  it('never returns less than the base, even for a zero/negative count', () => {
    expect(backoffMs(0)).toBe(RETRY_BASE_MS);
  });
});
