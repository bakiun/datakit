import { compareOffsets, type KafkaMessageQuery } from '@datakit/core';
import { parseLocalTime, parseOffset, parsePartition } from './format';

/** The filter chips of the message browser, and the query they make. */

export type FilterType = 'text' | 'partition' | 'offset' | 'date';

export interface FilterKind {
  type: FilterType;
  /** On the chip. */
  label: string;
  /** In the “+ Add filter” menu. */
  menu: string;
  range: boolean;
  from: string;
  to: string;
  /** Input width in characters. */
  width: number;
}

export const FILTER_KINDS: readonly FilterKind[] = [
  { type: 'text', label: 'Text', menu: 'Text contains', range: false, from: 'contains…', to: '', width: 22 },
  { type: 'partition', label: 'Partition', menu: 'Partition', range: false, from: '0', to: '', width: 5 },
  { type: 'offset', label: 'Offset', menu: 'Offset range', range: true, from: 'from', to: 'to', width: 11 },
  { type: 'date', label: 'Date', menu: 'Date range', range: true, from: 'YYYY-MM-DD HH:MM', to: 'YYYY-MM-DD HH:MM', width: 17 },
];

export const filterKind = (type: FilterType): FilterKind => FILTER_KINDS.find((k) => k.type === type)!;

export interface MessageFilter {
  id: number;
  type: FilterType;
  from: string;
  to: string;
}

export interface BuiltQuery {
  query: KafkaMessageQuery;
  /** Why a filter is left out, by filter id. */
  problems: Map<number, string>;
  /** Filters that narrow the query. */
  active: number;
}

/** The query of the filters; a filter that cannot be read is left out and named in `problems`. */
export function buildMessageQuery(topic: string, limit: number, partitions: number, filters: readonly MessageFilter[]): BuiltQuery {
  const query: KafkaMessageQuery = { topic, limit, partition: null, fromOffset: null, toOffset: null, fromTime: null, toTime: null, text: null };
  const problems = new Map<number, string>();
  let active = 0;
  for (const f of filters) {
    switch (f.type) {
      case 'text':
        if (f.from.trim()) {
          query.text = f.from.trim();
          active++;
        }
        break;
      case 'partition': {
        const p = parsePartition(f.from, partitions);
        if (p.error) problems.set(f.id, p.error);
        else if (p.value !== null) {
          query.partition = p.value;
          active++;
        }
        break;
      }
      case 'offset': {
        const from = parseOffset(f.from);
        const to = parseOffset(f.to);
        const error = from.error ?? to.error ?? (from.value !== null && to.value !== null && compareOffsets(from.value, to.value) > 0 ? 'The range starts after it ends.' : null);
        if (error) problems.set(f.id, error);
        else if (from.value !== null || to.value !== null) {
          query.fromOffset = from.value;
          query.toOffset = to.value;
          active++;
        }
        break;
      }
      case 'date': {
        const from = parseLocalTime(f.from);
        const to = parseLocalTime(f.to, true);
        const error = from.error ?? to.error ?? (from.value !== null && to.value !== null && from.value > to.value ? 'The range starts after it ends.' : null);
        if (error) problems.set(f.id, error);
        else if (from.value !== null || to.value !== null) {
          query.fromTime = from.value;
          query.toTime = to.value;
          active++;
        }
        break;
      }
    }
  }
  return { query, problems, active };
}
