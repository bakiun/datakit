import type { KafkaWorkspacePrefs } from '@datakit/core';
import type * as vscode from 'vscode';
import { StoredValue } from '../storedValue';

const STATE_KEY = 'datakit.kafkaFavourites';
const PREFS_KEY = 'datakit.kafkaPrefs';

/**
 * Starred topics and the remembered workspace choices (page size, last ksqlDB statement) per Kafka data source, kept
 * in global state like the data sources themselves. One per extension.
 */
export class KafkaFavourites {
  private readonly stored: StoredValue<Record<string, string[]>>;
  private readonly storedPrefs: StoredValue<Record<string, KafkaWorkspacePrefs>>;

  constructor(state: vscode.Memento) {
    this.stored = new StoredValue(state, STATE_KEY, {});
    this.storedPrefs = new StoredValue(state, PREFS_KEY, {});
  }

  list(dataSourceId: string): string[] {
    return [...(this.all()[dataSourceId] ?? [])];
  }

  /** Stars or unstars a topic and returns the new list, sorted by name. */
  async set(dataSourceId: string, topic: string, on: boolean): Promise<string[]> {
    const all = this.all();
    const names = new Set(all[dataSourceId] ?? []);
    if (on) names.add(topic);
    else names.delete(topic);
    const list = [...names].sort((a, b) => a.localeCompare(b));
    await this.stored.set({ ...all, [dataSourceId]: list });
    return list;
  }

  prefs(dataSourceId: string): KafkaWorkspacePrefs {
    return { ...(this.storedPrefs.get()[dataSourceId] ?? {}) };
  }

  /** Merges `patch` into the data source's remembered choices. */
  async setPrefs(dataSourceId: string, patch: KafkaWorkspacePrefs): Promise<void> {
    const all = this.storedPrefs.get();
    await this.storedPrefs.set({ ...all, [dataSourceId]: { ...all[dataSourceId], ...patch } });
  }

  async deleteFor(dataSourceId: string): Promise<void> {
    const { [dataSourceId]: _removed, ...rest } = this.all();
    await this.stored.set(rest);
    const { [dataSourceId]: _prefs, ...otherPrefs } = this.storedPrefs.get();
    await this.storedPrefs.set(otherPrefs);
  }

  private all(): Record<string, string[]> {
    return this.stored.get();
  }
}
