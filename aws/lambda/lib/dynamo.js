'use strict';

/**
 * DynamoDB DocumentClient shared by the Lambda handlers. Uses DynamoDB Local
 * while AWS_ACCESS_KEY_ID is unset or "placeholder". See aws/README.md.
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
