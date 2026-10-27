import { KAFKA_SECTIONS, KAFKA_VALUE_FORMATS, type KafkaSection } from '@datakit/core';
import { keepText, savedValue } from '../composables/usePersistedState';
import { FILTER_KINDS, type MessageFilter } from './messageQuery';
import type { ProduceDraft } from './workspace';

/**
 * What the Kafka workspace keeps across a reload of its page: where it was and what was typed per topic. Never
 * messages, topic lists, groups or configs, which are read again; nor a live stream, which is not started again.
 */

/** Topics whose filters and produce drafts are kept; the ones used last win. */
export const MAX_SAVED_TOPICS = 20;
/** A produce value or headers longer than this is not kept; a draft cut short would be wrong. */
export const MAX_SAVED_DRAFT = 20_000;
/** Topic and group names are short; anything longer is not a name. */
export const MAX_SAVED_NAME = 1_000;
const MAX_FIELD = 1_000;
const MAX_FILTERS = 50;
const MAX_SELECTED = 1_000;

export interface SavedWorkspace {
  section?: KafkaSection;
  /** The open topic of the Topics section; null for the topic list. */
  topic?: string | null;
  filters: Record<string, MessageFilter[]>;
  produce: Record<string, ProduceDraft>;
}

const SECTION_IDS = KAFKA_SECTIONS.map((s) => s.id);
const FILTER_TYPES = FILTER_KINDS.map((k) => k.type);
const VALUE_FORMATS = KAFKA_VALUE_FORMATS.map((f) => f.value);

/** The last `max` entries of a map, as an object. */
const lastEntries = <T>(map: ReadonlyMap<string, T>, max: number, keep: (value: T) => boolean = () => true) =>
  Object.fromEntries([...map].filter(([name, value]) => name.length <= MAX_SAVED_NAME && keep(value)).slice(-max));

export function workspaceToSave(
  section: KafkaSection,
  topic: string | null,
  memory: { filters: ReadonlyMap<string, MessageFilter[]>; produce: ReadonlyMap<string, ProduceDraft> },
): SavedWorkspace {
  return {
    section,
    topic: topic === null ? null : (keepText(topic, MAX_SAVED_NAME) ?? null),
    filters: lastEntries(memory.filters, MAX_SAVED_TOPICS, (list) => list.length > 0 && list.length <= MAX_FILTERS),
    produce: lastEntries(memory.produce, MAX_SAVED_TOPICS, (d) => d.value.length <= MAX_SAVED_DRAFT && d.headers.length <= MAX_SAVED_DRAFT),
  };
}

function readFilter(value: unknown): MessageFilter | undefined {
  const o = savedValue.object(value);
  const id = savedValue.integer(o?.id);
  const type = savedValue.oneOf(o?.type, FILTER_TYPES);
  const from = savedValue.string(o?.from, MAX_FIELD);
  const to = savedValue.string(o?.to, MAX_FIELD);
  return id === undefined || type === undefined || from === undefined || to === undefined ? undefined : { id, type, from, to };
}

function readDraft(value: unknown): ProduceDraft | undefined {
  const o = savedValue.object(value);
  if (!o) return undefined;
  const draft = {
    partition: savedValue.string(o.partition, MAX_FIELD),
    valueFormat: savedValue.oneOf(o.valueFormat, VALUE_FORMATS),
    key: savedValue.string(o.key, MAX_SAVED_DRAFT),
    keyNull: savedValue.boolean(o.keyNull),
    value: savedValue.string(o.value, MAX_SAVED_DRAFT),
    headers: savedValue.string(o.headers, MAX_SAVED_DRAFT),
    count: savedValue.string(o.count, MAX_FIELD),
  };
  return Object.values(draft).some((v) => v === undefined) ? undefined : (draft as ProduceDraft);
}

/** Entries of a saved object whose values read, at most `max` of them. */
function readEntries<T>(value: unknown, max: number, read: (value: unknown) => T | undefined): Record<string, T> {
  const entries: [string, T][] = [];
  for (const [name, item] of Object.entries(savedValue.object(value) ?? {}).slice(-max)) {
    const kept = name.length <= MAX_SAVED_NAME ? read(item) : undefined;
    if (kept !== undefined) entries.push([name, kept]);
  }
  return Object.fromEntries(entries);
}

export function readSavedWorkspace(saved: unknown): SavedWorkspace | undefined {
  const o = savedValue.object(saved);
  if (!o) return undefined;
  return {
    section: savedValue.oneOf(o.section, SECTION_IDS),
    topic: o.topic === null ? null : savedValue.string(o.topic, MAX_SAVED_NAME),
    filters: readEntries(o.filters, MAX_SAVED_TOPICS, (list) => {
      if (!Array.isArray(list)) return undefined;
      const filters = list.slice(0, MAX_FILTERS).map(readFilter).filter((f): f is MessageFilter => f !== undefined);
      return filters.length ? filters : undefined;
    }),
    produce: readEntries(o.produce, MAX_SAVED_TOPICS, readDraft),
  };
}

/** A topic's tab and whether its produce form was open. */
export interface SavedTopic {
  topic: string;
  tab?: 'messages' | 'settings' | 'consumers';
  produceOpen?: boolean;
}

export function readSavedTopic(saved: unknown): SavedTopic | undefined {
  const o = savedValue.object(saved);
  const topic = savedValue.string(o?.topic, MAX_SAVED_NAME);
  if (!o || topic === undefined) return undefined;
  return { topic, tab: savedValue.oneOf(o.tab, ['messages', 'settings', 'consumers'] as const), produceOpen: savedValue.boolean(o.produceOpen) };
}

/** The group picked on the Consumers page and the offset rows selected in it. */
export interface SavedConsumers {
  picked: string | null;
  selected: string[];
}

export function consumersToSave(picked: string | null, selected: ReadonlySet<string>): SavedConsumers | undefined {
  if (picked !== null && picked.length > MAX_SAVED_NAME) return undefined;
  return { picked, selected: [...selected].filter((key) => key.length <= MAX_SAVED_NAME * 2).slice(0, MAX_SELECTED) };
}

export function readSavedConsumers(saved: unknown): SavedConsumers | undefined {
  const o = savedValue.object(saved);
  if (!o) return undefined;
  const picked = savedValue.string(o.picked, MAX_SAVED_NAME);
  return { picked: picked === '' ? null : (picked ?? null), selected: savedValue.strings(o.selected, MAX_SELECTED, MAX_SAVED_NAME * 2) ?? [] };
}
