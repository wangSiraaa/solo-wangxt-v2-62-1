// Atomic JSON-file persistence.
//
// Save protocol (crash-safe):
//   1. serialize state together with its sha256 checksum into an envelope
//   2. write to "<file>.tmp"
//   3. fsync the tmp file
//   4. rename tmp -> file (atomic on POSIX and Windows NTFS)
//   5. fsync the containing directory
//
// Load verifies the checksum; a torn main file falls back to the most recent
// valid backup. Backups are rotated (default 3).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { canonicalJSON, sha256 } from './util.js';

export class JsonStore {
  constructor(filePath, { backups = 3 } = {}) {
    this.filePath = filePath;
    this.backupCount = backups;
    this.saveCount = 0;
  }

  async load() {
    const main = await this.#readChecked(this.filePath);
    if (main.ok) return main.data;

    // Try rotated backups, newest first.
    for (let i = 1; i <= this.backupCount; i++) {
      const candidate = await this.#readChecked(`${this.filePath}.bak${i}`);
      if (candidate.ok) {
        // Restore the good backup over the torn main file.
        await this.save(candidate.data);
        return candidate.data;
      }
    }
    const err = new Error(`数据文件无法读取或校验失败：${this.filePath}`);
    err.code = 'STORE_CORRUPT';
    throw err;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  async save(data) {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = canonicalJSON(data);
    const envelope = { schema: 'wedding-seating-store/v1', checksum: sha256(body), data: JSON.parse(body) };
    const payload = JSON.stringify(envelope, null, 2);

    // Rotate backups before overwriting.
    if (fs.existsSync(this.filePath)) {
      for (let i = this.backupCount; i >= 1; i--) {
        const src = i === 1 ? this.filePath : `${this.filePath}.bak${i - 1}`;
        const dst = `${this.filePath}.bak${i}`;
        if (fs.existsSync(src)) await fsp.copyFile(src, dst);
      }
    }

    const tmp = `${this.filePath}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(payload, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, this.filePath);
    await this.#fsyncDir(path.dirname(this.filePath));
    this.saveCount++;
  }

  async #readChecked(file) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const envelope = JSON.parse(raw);
      if (!envelope || envelope.schema !== 'wedding-seating-store/v1' || !envelope.checksum) {
        return { ok: false };
      }
      const body = canonicalJSON(envelope.data);
      if (sha256(body) !== envelope.checksum) return { ok: false };
      return { ok: true, data: envelope.data };
    } catch {
      return { ok: false };
    }
  }

  async #fsyncDir(dir) {
    try {
      const fh = await fsp.open(dir, 'r');
      await fh.sync();
      await fh.close();
    } catch {
      // directory fsync is best-effort (unsupported on some platforms)
    }
  }
}
