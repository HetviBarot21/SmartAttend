/**
 * JSON Schema (draft 2020-12) for the payload the PWA POSTs to /api/sync and
 * that the server in turn forwards to the AWS sync Lambda. Keep this in step
 * with aws/lambda/lib/attendanceSync.schema.js - the two are deliberately
 * duplicated so the Lambda can be deployed on its own.
 */

export const attendanceRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'studentId', 'date', 'status', 'createdAt'],
  properties: {
    eventId: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', minLength: 1, maxLength: 64 },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    status: { type: 'string', enum: ['present', 'absent', 'late'] },
    captureMethod: {
      type: 'string',
      enum: ['manual', 'rfid', 'fingerprint', 'import'],
      default: 'manual',
    },
    recordedBy: { type: ['string', 'null'], maxLength: 128 },
    // Why the student was absent, if the teacher said. Optional so older PWA
    // builds (which never send it) keep syncing. Only 'fee' and 'health' feed
    // the risk model; 'other' / 'unknown' let a teacher record something anyway.
    reason: { enum: ['fee', 'health', 'other', 'unknown', null] },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const attendanceSyncSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://smartattend.example/schemas/attendance-sync.json',
  title: 'AttendanceSyncBatch',
  type: 'object',
  additionalProperties: false,
  required: ['records'],
  properties: {
    deviceId: { type: 'string', maxLength: 128 },
    sentAt: { type: 'string', format: 'date-time' },
    records: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: attendanceRecordSchema,
    },
  },
};
