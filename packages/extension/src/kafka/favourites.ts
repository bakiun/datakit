import type * as vscode from 'vscode';
import { StoredValue } from '../storedValue';

const STATE_KEY = 'datakit.kafkaFavourites';

/** Starred topics per Kafka data source, kept in global state like the data sources themselves. One per extension. */
export class KafkaFavourites {
  private readonly stored: StoredValue<Record<string, string[]>>;

  constructor(state: vscode.Memento) {
    this.stored = new StoredValue(state, STATE_KEY, {});
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

  async deleteFor(dataSourceId: string): Promise<void> {
    const { [dataSourceId]: _removed, ...rest } = this.all();
    await this.stored.set(rest);
  }

  private all(): Record<string, string[]> {
    return this.stored.get();
  }
}
