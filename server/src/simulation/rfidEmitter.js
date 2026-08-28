import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pick } from '../lib/random.js';
import { config } from '../config.js';
import { DEMO_CARD_UIDS } from '../db/seed.js';

/**
 * Mock RFID reader.
 *
 * Emits a `card-detected` event on a fixed interval, each time with a random
 * card UID drawn from a hardcoded list (the demo class's cards). Stands in for
 * an MFRC522 reader wired to the door until real hardware arrives.
 *
 * Events:
 *   'card-detected'  ({ cardUid, scanId, detectedAt })
 *   'started'        ({ intervalMs, cards })
 *   'stopped'        ()
 *
 * Usage:
 *   const reader = new RfidEmitter();
 *   reader.on('card-detected', ({ cardUid }) => { ... });
 *   reader.start();
 */
export class RfidEmitter extends EventEmitter {
  /**
   * @param {object}   [opts]
   * @param {string[]} [opts.cardUids]   pool of UIDs to emit (default: demo class)
   * @param {number}   [opts.intervalMs] gap between scans (default: config)
   */
  constructor({ cardUids = DEMO_CARD_UIDS, intervalMs = config.rfidIntervalMs } = {}) {
    super();
    if (!Array.isArray(cardUids) || cardUids.length === 0) {
      throw new Error('RfidEmitter needs a non-empty cardUids list');
    }
    this.cardUids = [...cardUids];
    this.intervalMs = intervalMs;
    this._timer = null;
    this._count = 0;
  }

  get running() {
    return this._timer !== null;
  }

  get scanCount() {
    return this._count;
  }

  /** Begin emitting. No-op if already running. */
  start() {
    if (this._timer) return this;
    this._timer = setInterval(() => this._emitOne(), this.intervalMs);
    // Don't hold the process open on our account (matters for tests / shutdown).
    this._timer.unref?.();
    this.emit('started', { intervalMs: this.intervalMs, cards: this.cardUids.length });
    return this;
  }

  stop() {
    if (!this._timer) return this;
    clearInterval(this._timer);
    this._timer = null;
    this.emit('stopped');
    return this;
  }

  /** Fire a single scan immediately - handy for tests and for a manual trigger. */
  emitOnce() {
    return this._emitOne();
  }

  _emitOne() {
    const scan = {
      cardUid: pick(this.cardUids),
      scanId: randomUUID(),
      detectedAt: new Date().toISOString(),
    };
    this._count += 1;
    this.emit('card-detected', scan);
    return scan;
  }
}
