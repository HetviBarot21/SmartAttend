'use strict';

/**
 * Shared Ajv instance. Compiled validators are cached by $id so routes and the
 * worker can `getValidator(schema)` without recompiling on every request.
 */

const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, removeAdditional: false, useDefaults: true });
addFormats(ajv);

const cache = new WeakMap();

function getValidator(schema) {
  let validate = cache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    cache.set(schema, validate);
  }
  return validate;
}

/** Returns `{ valid, errors }` where errors is a compact, loggable array. */
function validate(schema, data) {
  const fn = getValidator(schema);
  const valid = fn(data);
  return {
    valid,
    errors: valid
      ? []
      : (fn.errors || []).map((e) => ({
          path: e.instancePath || '(root)',
          message: e.message,
          params: e.params
        }))
  };
}

module.exports = { ajv, getValidator, validate };
