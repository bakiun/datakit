import type { KafkaRecord, KafkaValueFormat } from './types';

/** The produce form: one message, optionally repeated `count` times with placeholders filled in per message. */
export interface KafkaProduceTemplate {
  /** Null lets the partitioner choose. */
  partition: number | null;
  /** Null sends a null key. */
  key: string | null;
  value: string;
  /** One header per line, `name=value`. */
  headers: string;
  count: number;
  valueFormat: KafkaValueFormat;
}

export const KAFKA_VALUE_FORMATS: readonly { value: KafkaValueFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'string', label: 'String' },
  { value: 'avro', label: 'Avro (Schema Registry)' },
  { value: 'int64', label: 'Int64' },
];

export const MAX_PRODUCE_COUNT = 100_000;

export const PRODUCE_PLACEHOLDERS = ['${counter}', '${uuid}', '${now}', '${random}'] as const;

/** Values for the placeholders of message `index` (0-based): `${counter}` counts from 1. */
export interface PlaceholderValues {
  uuid(): string;
  now: Date;
  random(): number;
}

export function expandPlaceholders(text: string, index: number, values: PlaceholderValues): string {
  return text.replace(/\$\{(counter|uuid|now|random)\}/g, (_, name: string) => {
    switch (name) {
      case 'counter':
        return String(index + 1);
      case 'uuid':
        return values.uuid();
      case 'now':
        return values.now.toISOString();
      default:
        return String(Math.floor(values.random() * 1_000_000));
    }
  });
}

/** Headers from `name=value` lines; blank lines are skipped. Throws on a line without `=`. */
export function parseHeaderLines(text: string): { key: string; value: string }[] {
  const headers: { key: string; value: string }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`Header line ${i + 1} is not name=value.`);
    headers.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  });
  return headers;
}

/** Placeholders replaced by a stand-in, so a JSON template can be checked before it is sent. */
const withStandIns = (text: string) => text.replace(/\$\{(counter|uuid|now|random)\}/g, '0');

/** Whether the value is valid for its format, ignoring placeholders; null when it is. */
export function valueProblem(value: string, format: KafkaValueFormat): string | null {
  if (format === 'json' || format === 'avro') {
    try {
      JSON.parse(withStandIns(value));
      return null;
    } catch {
      return format === 'avro' ? 'Avro values are written as JSON; this is not valid JSON.' : 'Not valid JSON.';
    }
  }
  if (format === 'int64' && !/^-?\d+$/.test(withStandIns(value).trim())) return 'Int64 values must be whole numbers.';
  return null;
}

/** Why the template cannot be produced; null when it can. */
export function produceProblem(template: KafkaProduceTemplate, partitions: number): string | null {
  if (!Number.isInteger(template.count) || template.count < 1 || template.count > MAX_PRODUCE_COUNT) {
    return `Count must be between 1 and ${MAX_PRODUCE_COUNT.toLocaleString('en-US')}.`;
  }
  if (template.partition !== null && (!Number.isInteger(template.partition) || template.partition < 0 || template.partition >= partitions)) {
    return `Partition must be between 0 and ${partitions - 1}.`;
  }
  try {
    parseHeaderLines(template.headers);
  } catch (error) {
    return (error as Error).message;
  }
  return valueProblem(template.value, template.valueFormat);
}

/** Message `index` of the template, placeholders filled in. JSON values are sent compact. */
export function recordOf(template: KafkaProduceTemplate, index: number, values: PlaceholderValues): KafkaRecord {
  const fill = (text: string) => expandPlaceholders(text, index, values);
  let value = fill(template.value);
  if (template.valueFormat === 'json') value = JSON.stringify(JSON.parse(value));
  return {
    partition: template.partition,
    key: template.key === null ? null : fill(template.key),
    value,
    headers: parseHeaderLines(template.headers).map((h) => ({ key: h.key, value: fill(h.value) })),
  };
}
