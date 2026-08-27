// jsdom does not expose structuredClone; fake-indexeddb needs it to clone
// records on write. The stored values are plain JSON-safe objects, so a
// JSON round-trip is a sufficient stand-in for the test environment.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// A fake IndexedDB implementation so Dexie runs under Node without a browser.
require('fake-indexeddb/auto');
require('@testing-library/jest-dom');
