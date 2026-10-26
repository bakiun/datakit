import type { SchemaCompatibility, SchemaRegistryClient, SchemaSubject, SchemaType, SchemaVersionDetail } from '@datakit/core';
import avro from 'avsc';
import { withSchemaId } from './payload';
import { mapLimited, RestClient, RestError } from './rest';

interface SchemaJson {
  subject: string;
  version: number;
  id: number;
  /** Left out for Avro. */
  schemaType?: SchemaType;
  schema: string;
}

/** Error codes of the registry that mean "not there" rather than failure. */
const SUBJECT_NOT_FOUND = 40401;
const VERSION_NOT_FOUND = 40402;
const SUBJECT_LEVEL_NOT_CONFIGURED = 40408;

const enc = encodeURIComponent;
const typeOf = (type: SchemaType | undefined): SchemaType => type ?? 'AVRO';
const isMissing = (error: unknown, ...codes: number[]) => error instanceof RestError && (error.status === 404 || (error.errorCode !== null && codes.includes(error.errorCode)));

export class SchemaRegistryRestClient implements SchemaRegistryClient {
  private readonly rest: RestClient;

  constructor(
    readonly url: string,
    timeoutMs: number,
  ) {
    this.rest = new RestClient('Schema Registry', url, timeoutMs, 'application/vnd.schemaregistry.v1+json');
  }

  async subjects(): Promise<SchemaSubject[]> {
    let latest: SchemaJson[];
    try {
      // One request for every subject, on registries from Confluent Platform 7.
      latest = await this.rest.json<SchemaJson[]>('/schemas?latestOnly=true');
    } catch (error) {
      if (!(error instanceof RestError)) throw error;
      const names = await this.rest.json<string[]>('/subjects');
      latest = await mapLimited(names, 8, (name) => this.latest(name));
    }
    return latest
      .map((s) => ({ name: s.subject, type: typeOf(s.schemaType), latestVersion: s.version, latestId: s.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The latest version of a subject as the registry sends it. */
  latest(subject: string): Promise<SchemaJson> {
    return this.rest.json<SchemaJson>(`/subjects/${enc(subject)}/versions/latest`);
  }

  async version(subject: string, version: number | 'latest'): Promise<SchemaVersionDetail> {
    const [schema, versions, compatibility] = await Promise.all([
      this.rest.json<SchemaJson>(`/subjects/${enc(subject)}/versions/${version}`),
      this.rest.json<number[]>(`/subjects/${enc(subject)}/versions`),
      this.subjectCompatibility(subject),
    ]);
    return {
      subject: schema.subject,
      version: schema.version,
      id: schema.id,
      type: typeOf(schema.schemaType),
      schema: schema.schema,
      versions: [...versions].sort((a, b) => a - b),
      compatibility,
    };
  }

  private async subjectCompatibility(subject: string): Promise<SchemaCompatibility | null> {
    try {
      return (await this.rest.json<{ compatibilityLevel: SchemaCompatibility }>(`/config/${enc(subject)}`)).compatibilityLevel ?? null;
    } catch (error) {
      if (isMissing(error, SUBJECT_LEVEL_NOT_CONFIGURED, SUBJECT_NOT_FOUND)) return null;
      throw error;
    }
  }

  async globalCompatibility(): Promise<SchemaCompatibility> {
    return (await this.rest.json<{ compatibilityLevel: SchemaCompatibility }>('/config')).compatibilityLevel;
  }

  async setGlobalCompatibility(level: SchemaCompatibility): Promise<void> {
    await this.rest.json('/config', { method: 'PUT', body: { compatibility: level } });
  }

  async setCompatibility(subject: string, level: SchemaCompatibility | null): Promise<void> {
    if (level !== null) {
      await this.rest.json(`/config/${enc(subject)}`, { method: 'PUT', body: { compatibility: level } });
      return;
    }
    try {
      await this.rest.json(`/config/${enc(subject)}`, { method: 'DELETE' });
    } catch (error) {
      if (!isMissing(error, SUBJECT_LEVEL_NOT_CONFIGURED, SUBJECT_NOT_FOUND)) throw error;
    }
  }

  async checkCompatibility(subject: string, type: SchemaType, schema: string): Promise<{ compatible: boolean; messages: string[] }> {
    try {
      const result = await this.rest.json<{ is_compatible: boolean; messages?: string[] }>(
        `/compatibility/subjects/${enc(subject)}/versions/latest?verbose=true`,
        { method: 'POST', body: { schema, schemaType: type } },
      );
      return { compatible: result.is_compatible, messages: result.messages ?? [] };
    } catch (error) {
      if (isMissing(error, SUBJECT_NOT_FOUND, VERSION_NOT_FOUND)) return { compatible: true, messages: [] };
      throw error;
    }
  }

  async register(subject: string, type: SchemaType, schema: string): Promise<number> {
    return (await this.rest.json<{ id: number }>(`/subjects/${enc(subject)}/versions`, { method: 'POST', body: { schema, schemaType: type } })).id;
  }

  async deleteVersion(subject: string, version: number, permanent: boolean): Promise<void> {
    await this.rest.json(`/subjects/${enc(subject)}/versions/${version}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' });
  }

  /** The schema with a global id, as stored. */
  async schemaById(id: number): Promise<{ type: SchemaType; schema: string }> {
    const found = await this.rest.json<{ schemaType?: SchemaType; schema: string }>(`/schemas/ids/${id}`);
    return { type: typeOf(found.schemaType), schema: found.schema };
  }

  /** The subject versions that use a schema id. */
  versionsOfId(id: number): Promise<{ subject: string; version: number }[]> {
    return this.rest.json<{ subject: string; version: number }[]>(`/schemas/ids/${id}/versions`);
  }
}

interface KnownSchema {
  type: SchemaType;
  /** Set for Avro. */
  avro: avro.Type | null;
}

/** Failed lookups are tried again after this long rather than on every message. */
const RETRY_FAILED_MS = 30_000;

/** Decodes and encodes payloads of the Schema Registry wire format; schemas are cached by id. */
export class SchemaCodec {
  private readonly schemas = new Map<number, { at: number; schema: Promise<KnownSchema | null> }>();

  constructor(readonly registry: SchemaRegistryRestClient) {}

  /** The schema of an id; null when the registry does not know it or cannot be reached. */
  schema(id: number): Promise<KnownSchema | null> {
    const cached = this.schemas.get(id);
    if (cached && (cached.at === 0 || Date.now() - cached.at < RETRY_FAILED_MS)) return cached.schema;
    const entry = { at: 0, schema: Promise.resolve<KnownSchema | null>(null) };
    entry.schema = this.registry
      .schemaById(id)
      .then(({ type, schema }) => ({ type, avro: type === 'AVRO' ? avro.Type.forSchema(JSON.parse(schema) as avro.Schema) : null }))
      .catch(() => {
        // Unknown, unreachable, or a schema avsc cannot read, e.g. one that references other subjects.
        entry.at = Date.now();
        return null;
      });
    this.schemas.set(id, entry);
    return entry.schema;
  }

  /** A wire-format payload as JSON text: Avro decoded with its schema, JSON Schema as sent; null for Protobuf or on failure. */
  async decode(bytes: Buffer, id: number): Promise<string | null> {
    const schema = await this.schema(id);
    if (!schema) return null;
    try {
      if (schema.type === 'JSON') return JSON.stringify(JSON.parse(bytes.subarray(5).toString('utf8')));
      if (schema.avro) return JSON.stringify(schema.avro.fromBuffer(bytes.subarray(5)), avroJsonReplacer);
    } catch {
      // The payload does not match its schema.
    }
    return null;
  }

  /** Encodes a JSON value with the latest Avro schema of `subject`. */
  async avroEncoder(subject: string): Promise<(json: string) => Buffer> {
    let latest: SchemaJson;
    try {
      latest = await this.registry.latest(subject);
    } catch (error) {
      if (isMissing(error, SUBJECT_NOT_FOUND, VERSION_NOT_FOUND)) throw new Error(`The Schema Registry has no subject ${subject}; register an Avro schema for it first.`);
      throw error;
    }
    if (typeOf(latest.schemaType) !== 'AVRO') throw new Error(`${subject} holds ${latest.schemaType} schemas, not Avro.`);
    const type = avro.Type.forSchema(JSON.parse(latest.schema) as avro.Schema);
    return (json) => {
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        throw new Error('Avro values are written as JSON; this is not valid JSON.');
      }
      const problems: string[] = [];
      if (!type.isValid(value, { errorHook: (path) => problems.push(path.join('.')) })) {
        const where = problems[0] ? ` at ${problems[0]}` : '';
        throw new Error(`The value does not match the schema of ${subject} v${latest.version}${where}.`);
      }
      return withSchemaId(latest.id, type.toBuffer(value));
    };
  }
}

/** Bytes and fixed values as Avro's JSON encoding writes them: one character per byte. */
function avroJsonReplacer(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key];
  if (Buffer.isBuffer(raw)) return raw.toString('latin1');
  return typeof value === 'bigint' ? value.toString() : value;
}
