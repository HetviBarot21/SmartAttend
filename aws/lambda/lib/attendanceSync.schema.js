'use strict';

/**
 * JSON Schema (draft 2020-12) for the sync batch API Gateway forwards to
 * syncHandler.js. Mirror of server/src/schemas/attendanceSync.schema.js - kept
 * as a separate copy so this Lambda deploys as a self-contained bundle.
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
