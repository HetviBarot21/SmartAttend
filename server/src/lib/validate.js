/**
 * Shared Ajv instance. Compiled validators are cached per schema object so
 * routes and the worker can `validate(schema, data)` without recompiling on
 * every request.
 */

import _Ajv from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';

// ajv and ajv-formats ship CJS; under ESM the callable lands on `.default`.
const Ajv = _Ajv.default || _Ajv;
const addFormats = _addFormats.default || _addFormats;

export const ajv = new Ajv({ allErrors: true, removeAdditional: false, useDefaults: true });
addFormats(ajv);

const cache = new WeakMap();

export function getValidator(schema) {
  let fn = cache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(schema, fn);
  }
  return fn;
}

/** Returns `{ valid, errors }` where errors is a compact, loggable array. */
export function validate(schema, data) {
  const fn = getValidator(schema);
  const valid = fn(data);
  return {
    valid,
    errors: valid
      ? []
      : (fn.errors || []).map((e) => ({
          path: e.instancePath || '(root)',
          message: e.message,
          params: e.params,
        })),
  };
}
