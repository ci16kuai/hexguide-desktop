import {readFile, mkdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createDefaultLayout, validateLayout, MAX_LAYOUT_BYTES} from '../dist/layout-config.js';

export class LayoutValidationError extends Error {}

/** Saves only the strictly enumerated layout model, independently of game and appearance state. */
export class LayoutStore {
  constructor({dataDirectory} = {}) {
    this.dataDirectory = dataDirectory;
    this.value = createDefaultLayout();
    this.persistTail = Promise.resolve();
    this.writeId = 0;
  }

  async load() {
    if (!this.dataDirectory) return this;
    try {
      const file = path.join(this.dataDirectory, 'ui-layout.json');
      if ((await stat(file)).size > MAX_LAYOUT_BYTES + 1) return this;
      const restored = validateLayout(JSON.parse(await readFile(file, 'utf8')));
      if (Buffer.byteLength(JSON.stringify(restored), 'utf8') > MAX_LAYOUT_BYTES) return this;
      this.value = restored;
    } catch { /* Missing, corrupt and unsupported layouts all keep a usable default interface. */ }
    return this;
  }

  get() { return structuredClone(this.value); }

  async set(input) {
    let next, payload;
    try {
      next = validateLayout(input);
      payload = JSON.stringify(next);
      if (Buffer.byteLength(payload, 'utf8') > MAX_LAYOUT_BYTES) throw new TypeError('Layout is too large.');
    }
    catch { throw new LayoutValidationError('Invalid interface layout.'); }
    const write = this.persistTail.catch(() => {}).then(async () => {
      if (this.dataDirectory) {
        await mkdir(this.dataDirectory, {recursive:true});
        const file = path.join(this.dataDirectory, 'ui-layout.json');
        const temporary = `${file}.tmp-${process.pid}-${++this.writeId}`;
        try {
          await writeFile(temporary, payload + '\n', {encoding:'utf8', mode:0o600});
          await rename(temporary, file);
        } finally { await rm(temporary, {force:true}).catch(() => {}); }
      }
      // A failed disk write must not publish an unsaved model to another consumer.
      this.value = next;
    });
    this.persistTail = write;
    await write;
    return structuredClone(next);
  }

  async flush() { await this.persistTail.catch(() => {}); }
}
