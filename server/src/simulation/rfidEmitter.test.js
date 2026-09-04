import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RfidEmitter } from './rfidEmitter.js';

const CARDS = ['04A1B2C3', '04D4E5F6', '0417A8B9'];

describe('RfidEmitter', () => {
  test('emitOnce fires card-detected with a UID from the pool', () => {
    const reader = new RfidEmitter({ cardUids: CARDS });
    const seen = [];
    reader.on('card-detected', (scan) => seen.push(scan));

    const scan = reader.emitOnce();
    assert.equal(seen.length, 1);
    assert.ok(CARDS.includes(scan.cardUid));
    assert.ok(scan.scanId);
    assert.ok(!Number.isNaN(Date.parse(scan.detectedAt)));
    assert.equal(reader.scanCount, 1);
  });

  test('rejects an empty card pool', () => {
    assert.throws(() => new RfidEmitter({ cardUids: [] }));
  });

  describe('with mocked timers', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
    afterEach(() => mock.timers.reset());

    test('emits once per interval while running, and stops on stop()', () => {
      const reader = new RfidEmitter({ cardUids: CARDS, intervalMs: 5000 });
      let count = 0;
      reader.on('card-detected', () => count++);

      reader.start();
      assert.equal(reader.running, true);

      mock.timers.tick(5000);
      mock.timers.tick(5000);
      mock.timers.tick(5000);
      assert.equal(count, 3);

      reader.stop();
      assert.equal(reader.running, false);
      mock.timers.tick(20000);
      assert.equal(count, 3, 'no more events after stop()');
    });

    test('start() is idempotent', () => {
      const reader = new RfidEmitter({ cardUids: CARDS, intervalMs: 1000 });
      let count = 0;
      reader.on('card-detected', () => count++);
      reader.start();
      reader.start();
      mock.timers.tick(1000);
      assert.equal(count, 1);
    });
  });
});
