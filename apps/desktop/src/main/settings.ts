import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Settings {
  /** The port the server bound last time it started. Shown in the UI. */
  port?: number;
}

/** A small JSON file under userData. Unknown or malformed content reads as defaults. */
export function settingsFile(path: string) {
  function read(): Settings {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return Number.isInteger(data.port) ? { port: data.port as number } : {};
    } catch {
      return {};
    }
  }

  return {
    read,
    update(patch: Partial<Settings>): void {
      const next = { ...read(), ...patch };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${path}.tmp`, path);
    }
  };
}
