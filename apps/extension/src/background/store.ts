/** One `chrome.storage` area, narrowed to what the worker uses, so tests can fake it. */
export interface KeyValueArea {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function chromeArea(area: chrome.storage.StorageArea): KeyValueArea {
  return {
    async get(key) {
      const items = await area.get(key);
      return items[key];
    },
    set: (key, value) => area.set({ [key]: value })
  };
}

/** An in-memory area for tests. */
export function memoryArea(initial: Record<string, unknown> = {}): KeyValueArea & {
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    get: (key) => Promise.resolve(structuredClone(data[key])),
    set: (key, value) => {
      data[key] = structuredClone(value);
      return Promise.resolve();
    }
  };
}

/** Runs read-modify-write tasks one at a time, so two messages can't lose an update. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
