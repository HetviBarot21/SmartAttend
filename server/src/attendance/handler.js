import { chance } from '../lib/random.js';
import { scanFingerprint } from '../simulation/fingerprintSimulator.js';
import { config } from '../config.js';
import {
  findStudentByCardUid,
  recordAttendance,
  logFingerprintChallenge,
  logAudit,
  DuplicateAttendanceError,
  todayISO,
} from '../db/repository.js';

/**
 * Turn an RFID scan into an attendance record. Some scans (`challengeRate`)
 * also need a fingerprint match; a failed match rejects the scan.
 *
 * @returns {(scan: {cardUid: string, scanId?: string}) => object}
 *          returns an outcome object instead of throwing for an unknown card,
 *          a duplicate or a rejection.
 */
export function createCardHandler({
  db,
  challengeRate = config.fingerprintChallengeRate,
  successRate = config.fingerprintSuccessRate,
} = {}) {
  if (!db) throw new Error('createCardHandler needs a db');

  return function handleCardDetected(scan) {
    const cardUid = typeof scan === 'string' ? scan : scan?.cardUid;
    const date = todayISO();

    const student = findStudentByCardUid(db, cardUid);
    if (!student) {
      logAudit(db, { action: 'rfid.unknown_card', recordId: cardUid, detail: { cardUid, scanId: scan?.scanId } });
      return { outcome: 'unknown-card', cardUid };
    }

    const challenged = chance(challengeRate);
    let fingerprint = null;

    if (challenged) {
      fingerprint = scanFingerprint({ studentId: student.student_id, cardUid }, successRate);

      if (!fingerprint.match) {
        const challenge = logFingerprintChallenge(db, {
          studentId: student.student_id,
          cardUid,
          eventId: null,
          result: 'no_match',
          successRate,
        });
        logAudit(db, {
          action: 'attendance.rejected',
          recordId: student.student_id,
          detail: { reason: 'fingerprint_no_match', cardUid, confidence: fingerprint.confidence },
        });
        return { outcome: 'rejected', student, challenged: true, fingerprint, challenge, date };
      }
    }

    const captureMethod = challenged ? 'fingerprint' : 'rfid';

    let event;
    try {
      event = recordAttendance(db, {
        studentId: student.student_id,
        date,
        status: 'present',
        captureMethod,
        verified: challenged ? 1 : 0,
        recordedBy: null,
        source: 'simulation',
      });
    } catch (err) {
      if (err instanceof DuplicateAttendanceError) {
        if (challenged) {
          logFingerprintChallenge(db, {
            studentId: student.student_id,
            cardUid,
            eventId: null,
            result: 'match',
            successRate,
          });
        }
        return { outcome: 'duplicate', student, challenged, fingerprint, date };
      }
      throw err;
    }

    let challenge = null;
    if (challenged) {
      challenge = logFingerprintChallenge(db, {
        studentId: student.student_id,
        cardUid,
        eventId: event.eventId,
        result: 'match',
        successRate,
      });
    }

    return { outcome: 'recorded', student, event, challenged, fingerprint, challenge, date };
  };
}
