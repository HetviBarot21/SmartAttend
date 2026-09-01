'use strict';

/**
 * DynamoDB DocumentClient factory shared by the Lambda handlers.
 *
 * ---------------------------------------------------------------------------
 * LOCAL MODE (default while AWS_ACCESS_KEY_ID is unset or "placeholder"):
 *   Targets DynamoDB Local. Start it with:
 *       docker run -p 8000:8000 amazon/dynamodb-local
 *   and create the tables (see aws/README.md for the CreateTable commands).
 *
 * SWITCHING TO REAL AWS when credentials arrive:
 *   1. Give the Lambda an execution role with DynamoDB + SES permissions and
 *      DELETE AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from its environment
 *      (the SDK then uses the role automatically). If you must use static keys,
 *      set them to the real values instead of "placeholder".
 *   2. Remove the DYNAMODB_ENDPOINT variable so the SDK resolves the real
 *      regional endpoint.
 *   Nothing else in the handlers changes.
 * ---------------------------------------------------------------------------
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

function usingPlaceholderCredentials() {
  const key = process.env.AWS_ACCESS_KEY_ID;
  return !key || key === 'placeholder';
}

function createDocClient() {
  const region = process.env.AWS_REGION || 'af-south-1';

  const base = usingPlaceholderCredentials()
    ? new DynamoDBClient({
        region,
        endpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' }
      })
    : new DynamoDBClient({ region });

  return DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true }
  });
}

module.exports = { createDocClient, usingPlaceholderCredentials };
