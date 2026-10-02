/**
 * Inbound half of the gate <-> teacher loop: pull what the school gate (Tier 2
 * RFID + fingerprint server) has recorded for a class today, so the roll call
 * only asks the teacher about students who did not scan in.
 *
 *   gate scans -> Tier 2 SQLite -> GET /api/gate/classes/:id/attendance
 *                                          |
 *                               **pullGateAttendance()**  <- this module
 *                                          |
 *                     applyGateRecords() -> Dexie `attendanceEvents`
 *
 * The phone talks to the gate over the school's local network, not the
 * internet. If it cannot reach the gate (out of Wi-Fi range, gate box down,
 * or a school with no gate at all) this resolves - never throws - with a
 * status telling the roll call to fall back to a full manual register.
 * Teacher marks still go up the other way through services/syncService.js.
 */

import { applyGateRecords, todayISO, GATE_CAPTURE_METHODS } from '../db/database';

/** Same-origin endpoint on the Tier 2 Express server (Vite proxies /api in dev). */
export function gateEndpoint(classGroupId, date) {
  return `/api/gate/classes/${encodeURIComponent(classGroupId)}/attendance?date=${date}`;
}

/** Give up on the gate after this long so the roll call is never held hostage. */
export const GATE_TIMEOUT_MS = 5000;

/**
 * @typedef {'active'|'no-scans'|'unreachable'|'unknown-class'} GateStatus
 *   active        - the gate has scanned students today; its records are merged
 *   no-scans      - reachable, but nothing scanned today (early, or reader down)
 *   unreachable   - could not talk to the gate server at all
 *   unknown-class - the gate server does not have this class on its roster
 */

/**
 * Fetch today's gate records for a class and merge them into Dexie.
 *
 * @param {string} classGroupId
 * @param {object} [opts]
 * @param {string} [opts.date=todayISO()]
 * @param {typeof fetch} [opts.fetchImpl=globalThis.fetch]
 * @param {number} [opts.timeoutMs=GATE_TIMEOUT_MS]
 * @returns {Promise<{status: GateStatus, lastScanAt: string|null, scannedCount: number,
 *   added: string[], updated: string[], replaced: object[]}>}
 */
export async function pullGateAttendance(classGroupId, {
  date = todayISO(),
  fetchImpl = globalThis.fetch,
  timeoutMs = GATE_TIMEOUT_MS,
} = {}) {
  const empty = { lastScanAt: null, scannedCount: 0, added: [], updated: [], replaced: [] };
  if (typeof fetchImpl !== 'function') return { status: 'unreachable', ...empty };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response;
  try {
    response = await fetchImpl(gateEndpoint(classGroupId, date), { signal: controller?.signal });
  } catch {
    return { status: 'unreachable', ...empty };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (response.status === 404) return { status: 'unknown-class', ...empty };
  if (!response.ok) return { status: 'unreachable', ...empty };

  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.records)) return { status: 'unreachable', ...empty };

  const merged = await applyGateRecords(body.records);
  const lastScanAt = body.gate?.lastScanAt ?? null;
  const scannedToday = lastScanAt != null && todayISO(new Date(lastScanAt)) === date;

  return {
    status: scannedToday ? 'active' : 'no-scans',
    lastScanAt,
    scannedCount: body.records.filter((r) => GATE_CAPTURE_METHODS.includes(r.captureMethod)).length,
    ...merged,
  };
}
