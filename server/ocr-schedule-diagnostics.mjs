import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {OCR_SCHEDULE_MODES} from './ocr-schedule.mjs';
import {sanitizeScanCode, sanitizeOcrMeasurements} from './scan-diagnostics.mjs';

const MODES = new Set(OCR_SCHEDULE_MODES);
const THROTTLE_MS = 5000;
const MAX_BYTES = 4095;
const boundedInteger = (value, maximum) => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(maximum, Math.max(0, Math.floor(value))) : 0;
const timestamp = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= 8640000000000000 ? Math.floor(value) : 0;

/** Fixed product diagnostics only. Never persist candidate names, images, session IDs or errors. */
export class OcrScheduleDiagnostics {
  constructor({dataDirectory, now = () => Date.now()} = {}) {
    this.directory = dataDirectory ? path.join(dataDirectory, 'diagnostics') : null;
    this.now = now;
    this.latest = this.pending = this.running = this.timer = null;
    this.lastAttempt = null;
    this.lastAttemptAt = 0;
    this.revision = this.writtenRevision = this.writeId = 0;
    this.closed = false;
    this.closeTask = null;
    this.recentScans = [];
    this.lastScanAt = null;
  }

  publish(input) {
    if (this.closed || !this.directory) return Promise.resolve();
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const mode = MODES.has(value.mode) ? value.mode : 'inactive';
    const snapshot = {
      schemaVersion:2,
      appVersion:'1.17.16',
      updatedAtUtc:new Date(timestamp(this.now())).toISOString(),
      mode,
      due:value.due === true,
      intervalMs:boundedInteger(value.intervalMs, 30000),
      nextInMs:boundedInteger(value.nextInMs, 30000),
      windowRemainingMs:boundedInteger(value.windowRemainingMs, 120000),
      trigger:['game-start','death','respawn'].includes(value.trigger) ? value.trigger : null,
      windowId:Number.isSafeInteger(value.windowId) && value.windowId > 0 ? value.windowId : null,
      scanCount:boundedInteger(value.scanCount, 1000000),
      failureCount:boundedInteger(value.failureCount, 1000000),
      lastDurationMs:boundedInteger(value.lastDurationMs, 60000),
    };
    const scan = value.lastScan;
    if (Number.isSafeInteger(scan?.completedAt) && scan.completedAt >= 0
      && scan.completedAt <= timestamp(this.now()) && ['recognized','waiting','unavailable'].includes(scan.status)) {
      snapshot.lastScan = {completedAt:scan.completedAt,status:scan.status,
        code:sanitizeScanCode(scan.code),diagnostics:sanitizeOcrMeasurements(scan.diagnostics)};
      if (scan.completedAt !== this.lastScanAt) {
        this.lastScanAt = scan.completedAt;
        const previous = this.recentScans.at(-1);
        // Repeated empty frames cannot erase the preceding recognition/rejection
        // immediately. Keep transitions, not an unbounded per-frame log.
        if (previous?.code === snapshot.lastScan.code && previous?.status === snapshot.lastScan.status) this.recentScans[this.recentScans.length - 1] = snapshot.lastScan;
        else this.recentScans = [...this.recentScans.slice(-3),snapshot.lastScan];
      }
      snapshot.recentScans = [...this.recentScans];
    }
    // There is one latest pending value, not an ever-growing promise/write queue.
    this.latest = this.pending = {revision:++this.revision, value:snapshot};
    if (this.isDue(snapshot)) {
      clearTimeout(this.timer); this.timer = null;
      return this.drain();
    }
    this.schedule();
    return this.running || Promise.resolve();
  }

  isDue(value) {
    const now = timestamp(this.now());
    return !this.lastAttempt || value.mode !== this.lastAttempt.mode
      || value.windowId !== this.lastAttempt.windowId || value.trigger !== this.lastAttempt.trigger
      || value.scanCount !== this.lastAttempt.scanCount
      || value.lastScan?.completedAt !== this.lastAttempt.lastScan?.completedAt
      || now < this.lastAttemptAt || now - this.lastAttemptAt >= THROTTLE_MS;
  }

  schedule() {
    if (this.closed || this.timer || !this.pending) return;
    const delay = Math.max(1, THROTTLE_MS - (timestamp(this.now()) - this.lastAttemptAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.min(THROTTLE_MS, delay));
    this.timer.unref?.();
  }

  drain(force = false) {
    if (this.running) return this.running;
    const run = async () => {
      while (this.pending) {
        if (!force && !this.isDue(this.pending.value)) { this.schedule(); break; }
        const entry = this.pending;
        this.pending = null;
        this.lastAttempt = entry.value;
        this.lastAttemptAt = timestamp(this.now());
        if (await this.write(entry.value)) this.writtenRevision = entry.revision;
      }
    };
    this.running = run().catch(() => {}).finally(() => {
      this.running = null;
      if (this.pending && !this.closed) {
        if (this.isDue(this.pending.value)) void this.drain();
        else this.schedule();
      }
    });
    return this.running;
  }

  async write(value) {
    const file = path.join(this.directory, 'ocr-schedule.json');
    const temporary = `${file}.tmp-${process.pid}-${++this.writeId}`;
    try {
      const text = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(text) > MAX_BYTES) return false;
      await mkdir(this.directory, {recursive:true});
      await writeFile(temporary, text, {encoding:'utf8', mode:0o600});
      await rename(temporary, file);
      return true;
    } catch { return false; }
    finally { await rm(temporary, {force:true}).catch(() => {}); }
  }

  close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    clearTimeout(this.timer); this.timer = null;
    this.closeTask = (async () => {
      await this.running;
      // Retry a failed final write once, without holding up the scan lifecycle.
      if (this.latest && this.latest.revision > this.writtenRevision) {
        this.pending = this.latest;
        await this.drain(true);
      }
    })().catch(() => {});
    return this.closeTask;
  }
}
