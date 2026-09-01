'use strict';

/**
 * AWS Lambda - attendance sync ingest (behind API Gateway, POST /sync).
 *
 * Flow:
 *   1. Parse + validate the batch with Ajv (attendanceSync.schema.js).
 *   2. Collapse duplicate eventIds inside the payload.
 *   3. BatchGetItem on ATTENDANCE_TABLE (key: eventId) to find records already
 *      stored -> those are "skipped".
 *   4. BatchWriteItem the survivors into ATTENDANCE_TABLE.
 *   5. BatchWriteItem one audit entry per successfully written record into
 *      AUDIT_TABLE.
 *   6. Return { inserted, skipped, failed } so the Tier 2 worker knows which
 *      queue rows to close and which to retry.
 *
 * Table assumptions (DynamoDB):
 *   ATTENDANCE_TABLE  partition key: eventId (S)
 *   AUDIT_TABLE       partition key: auditId (S)
 */

const crypto = require('crypto');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { BatchGetCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const { createDocClient } = require('./lib/dynamo');
const { attendanceSyncSchema } = require('./lib/attendanceSync.schema');

const ajv = new Ajv({ allErrors: true, useDefaults: true });
addFormats(ajv);
const validateBatch = ajv.compile(attendanceSyncSchema);

const ddb = createDocClient();
const ATTENDANCE_TABLE = process.env.ATTENDANCE_TABLE || 'attendance-events';
const AUDIT_TABLE = process.env.AUDIT_TABLE || 'audit-log';

const BATCH_GET_MAX = 100;
const BATCH_WRITE_MAX = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (!event || event.body == null) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  if (typeof raw === 'object') return raw; // direct invoke / already parsed
  return JSON.parse(raw);
}

/** eventIds from `ids` that already exist in ATTENDANCE_TABLE. */
async function findExistingEventIds(ids) {
  const existing = new Set();
  for (const group of chunk(ids, BATCH_GET_MAX)) {
    let keys = group.map((eventId) => ({ eventId }));
    // retry UnprocessedKeys with exponential backoff
    for (let attempt = 0; attempt < 5 && keys.length; attempt += 1) {
      if (attempt) await sleep(2 ** attempt * 50);
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [ATTENDANCE_TABLE]: { Keys: keys, ProjectionExpression: 'eventId' }
          }
        })
      );
      for (const item of res.Responses?.[ATTENDANCE_TABLE] ?? []) existing.add(item.eventId);
      keys = res.UnprocessedKeys?.[ATTENDANCE_TABLE]?.Keys ?? [];
    }
    if (keys.length) {
      throw new Error(`BatchGetItem left ${keys.length} keys unprocessed after retries`);
    }
  }
  return existing;
}

/** BatchWrite `items` (Put) into `table`. Returns the items that never landed. */
async function batchPut(table, items) {
  const failed = [];
  for (const group of chunk(items, BATCH_WRITE_MAX)) {
    let requests = group.map((Item) => ({ PutRequest: { Item } }));
    let attempt = 0;
    while (requests.length && attempt < 6) {
      if (attempt) await sleep(2 ** attempt * 50);
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [table]: requests } })
      );
      requests = res.UnprocessedItems?.[table] ?? [];
      attempt += 1;
    }
    for (const r of requests) failed.push(r.PutRequest.Item);
  }
  return failed;
}

exports.handler = async (event) => {
  let payload;
  try {
    payload = parseBody(event);
  } catch (err) {
    return json(400, { error: 'body is not valid JSON', detail: err.message });
  }

  if (!validateBatch(payload)) {
    return json(400, {
      error: 'invalid sync payload',
      details: (validateBatch.errors || []).map((e) => ({
        path: e.instancePath || '(root)',
        message: e.message
      }))
    });
  }

  const { records, deviceId } = payload;
  const now = new Date().toISOString();

  // De-dupe within the payload (keep first occurrence of each eventId).
  const byEventId = new Map();
  for (const r of records) if (!byEventId.has(r.eventId)) byEventId.set(r.eventId, r);
  const unique = [...byEventId.values()];

  let existing;
  try {
    existing = await findExistingEventIds([...byEventId.keys()]);
  } catch (err) {
    // Cannot tell new from old -> ask the caller to retry the whole batch.
    return json(503, { error: 'dedupe lookup failed', detail: err.message });
  }

  const toInsert = unique.filter((r) => !existing.has(r.eventId));
  const skipped = unique
    .filter((r) => existing.has(r.eventId))
    .map((r) => ({ eventId: r.eventId, reason: 'duplicate_event_id' }));

  // Write attendance rows.
  const attendanceItems = toInsert.map((r) => ({
    eventId: r.eventId,
    studentId: r.studentId,
    date: r.date,
    status: r.status,
    captureMethod: r.captureMethod || 'manual',
    recordedBy: r.recordedBy ?? null,
    createdAt: r.createdAt,
    syncedAt: now,
    source: deviceId || 'unknown'
  }));

  let writeFailedItems = [];
  try {
    writeFailedItems = await batchPut(ATTENDANCE_TABLE, attendanceItems);
  } catch (err) {
    return json(503, { error: 'attendance write failed', detail: err.message });
  }
  const failedIds = new Set(writeFailedItems.map((i) => i.eventId));
  const inserted = toInsert.map((r) => r.eventId).filter((id) => !failedIds.has(id));

  // One audit entry per successfully written record.
  const auditItems = inserted.map((eventId) => {
    const rec = byEventId.get(eventId);
    return {
      auditId: crypto.randomUUID(),
      action: 'sync.persisted',
      actorId: rec.recordedBy ?? deviceId ?? null,
      recordId: eventId,
      detail: JSON.stringify({ studentId: rec.studentId, date: rec.date, status: rec.status }),
      timestamp: now
    };
  });
  try {
    const auditFailed = await batchPut(AUDIT_TABLE, auditItems);
    if (auditFailed.length) {
      console.warn(`[syncHandler] ${auditFailed.length} audit rows not written`);
    }
  } catch (err) {
    // Audit is best-effort: the attendance rows are already committed, so don't
    // fail the whole request (which would cause duplicate-safe re-sends anyway).
    console.error('[syncHandler] audit write error', err);
  }

  return json(200, {
    received: records.length,
    insertedCount: inserted.length,
    skippedCount: skipped.length,
    failedCount: failedIds.size,
    inserted,
    skipped,
    failed: [...failedIds].map((eventId) => ({ eventId, reason: 'write_unprocessed' }))
  });
};
