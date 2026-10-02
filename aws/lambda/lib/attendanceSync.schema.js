'use strict';

/**
 * Copy of server/src/schemas/attendanceSync.schema.js so the Lambda deploys on
 * its own. Keep the two in step.
 */

const attendanceRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'studentId', 'date', 'status', 'createdAt'],
  properties: {
    eventId: { type: 'string', format: 'uuid' },
    studentId: { type: 'string', minLength: 1, maxLength: 64 },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    status: { type: 'string', enum: ['present', 'absent', 'late'] },
    captureMethod: { type: 'string', enum: ['manual', 'rfid', 'fingerprint', 'import'], default: 'manual' },
    recordedBy: { type: ['string', 'null'], maxLength: 128 },
    reason: { enum: ['fee', 'health', 'other', 'unknown', null] },
    createdAt: { type: 'string', format: 'date-time' }
  }
};

const attendanceSyncSchema = {
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
      items: attendanceRecordSchema
    }
  }
};

module.exports = { attendanceSyncSchema, attendanceRecordSchema };
