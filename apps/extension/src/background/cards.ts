import { CardRecord } from '../messages';
import { Serial, type KeyValueArea } from './store';

export const CARD_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const STORAGE_KEY = 'cards';

/**
 * Diff card state by block key (`conversationId:messageId:blockIndex:contentHash`), kept
 * in `chrome.storage.local` so a reload shows Applied/Rejected/Undone as it was. Records
 * not touched for 30 days are dropped on every write.
 */
export class CardStore {
  private readonly serial = new Serial();

  constructor(
    private readonly area: KeyValueArea,
    private readonly now: () => number = Date.now
  ) {}

  private async load(): Promise<Record<string, CardRecord>> {
    const raw = await this.area.get(STORAGE_KEY);
    const records: Record<string, CardRecord> = {};
    if (typeof raw !== 'object' || raw === null) return records;
    for (const [key, value] of Object.entries(raw)) {
      const parsed = CardRecord.safeParse(value);
      if (parsed.success) records[key] = parsed.data;
    }
    return records;
  }

  async get(keys: readonly string[]): Promise<Record<string, CardRecord>> {
    const records = await this.load();
    const found: Record<string, CardRecord> = {};
    for (const key of keys) {
      const record = records[key];
      if (record) found[key] = record;
    }
    return found;
  }

  set(key: string, record: CardRecord): Promise<void> {
    return this.serial.run(async () => {
      const records = this.pruned(await this.load());
      records[key] = record;
      await this.area.set(STORAGE_KEY, records);
    });
  }

  /** Drops records older than 30 days. Returns how many went. */
  prune(): Promise<number> {
    return this.serial.run(async () => {
      const records = await this.load();
      const kept = this.pruned(records);
      const removed = Object.keys(records).length - Object.keys(kept).length;
      if (removed > 0) await this.area.set(STORAGE_KEY, kept);
      return removed;
    });
  }

  /** How many cards in a conversation are applied, and how many still wait for review. */
  async counts(conversationId: string): Promise<{ applied: number; pending: number }> {
    const records = await this.load();
    let applied = 0;
    let pending = 0;
    for (const [key, record] of Object.entries(records)) {
      if (!key.startsWith(`${conversationId}:`)) continue;
      if (record.state === 'applied') applied += 1;
      if (record.state === 'pending') pending += 1;
    }
    return { applied, pending };
  }

  private pruned(records: Record<string, CardRecord>): Record<string, CardRecord> {
    const cutoff = this.now() - CARD_MAX_AGE_MS;
    return Object.fromEntries(Object.entries(records).filter(([, r]) => r.updatedAt >= cutoff));
  }
}
