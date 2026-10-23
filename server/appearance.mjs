import {readFile, mkdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createDefaultAppearance, validateAppearance} from '../dist/appearance-config.js';

export class AppearanceValidationError extends Error {}

/** Display preferences only; no game state, credentials, file paths or custom CSS are accepted. */
export class AppearanceStore {
  constructor({dataDirectory} = {}) {
    this.dataDirectory = dataDirectory;
    this.value = createDefaultAppearance();
    this.persistTail = Promise.resolve();
    this.writeId = 0;
  }

  async load() {
    if (!this.dataDirectory) return this;
    try {
      const file = path.join(this.dataDirectory, 'appearance.json');
      if ((await stat(file)).size > 4096) return this;
      this.value = validateAppearance(JSON.parse(await readFile(file, 'utf8')));
      // Every app start docks left; preserve all other preferences without rewriting the saved file.
      this.value.sidebar.side = 'left';
    } catch { /* Missing, corrupt or unsupported settings use safe defaults. */ }
    return this;
  }

  get() { return structuredClone(this.value); }

  async set(input) {
    let next;
    try { next = validateAppearance(input); }
    catch { throw new AppearanceValidationError('Invalid appearance settings.'); }
    const write = this.persistTail.catch(() => {}).then(async () => {
      if (this.dataDirectory) {
        await mkdir(this.dataDirectory, {recursive:true});
        const file = path.join(this.dataDirectory, 'appearance.json');
        const temporary = `${file}.tmp-${process.pid}-${++this.writeId}`;
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', {encoding:'utf8', mode:0o600});
          await rename(temporary, file);
        } finally { await rm(temporary, {force:true}).catch(() => {}); }
      }
      // A failed write must not advertise unsaved settings to the other window.
      this.value = next;
    });
    this.persistTail = write;
    await write;
    return structuredClone(next);
  }

  async flush() { await this.persistTail.catch(() => {}); }
}
