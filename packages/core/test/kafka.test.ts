import { describe, expect, it } from 'vitest';
import {
  aclsFromTemplate,
  aclTemplateProblem,
  buildConnectionUrl,
  compareOffsets,
  createDataSourceSettings,
  describeEndpoint,
  expandPlaceholders,
  formatDuration,
  kafkaHealth,
  kafkaReleaseOfMetadataLevel,
  kafkaSecurityProtocol,
  messageContains,
  needsPassword,
  needsUser,
  parseConnectionUrl,
  parseHeaderLines,
  parseHostPort,
  produceProblem,
  recordOf,
  retentionLabel,
  setKafkaSecurityProtocol,
  topicNameProblem,
  validateDataSource,
  valueProblem,
  type DataSourceSettings,
  type KafkaMessage,
  type KafkaOverview,
  type KafkaProduceTemplate,
} from '../src';

function kafka(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('kafka');
  s.name = 'events';
  patch(s);
  return s;
}

describe('Kafka settings', () => {
  it('starts as PLAINTEXT on localhost:9092 and needs no password', () => {
    const s = kafka();
    expect(kafkaSecurityProtocol(s)).toBe('PLAINTEXT');
    expect(needsPassword(s)).toBe(false);
    expect(describeEndpoint(s)).toBe('localhost:9092');
    expect(validateDataSource(s, [])).toEqual({});
  });

  it('maps the security protocol to SASL and TLS', () => {
    const s = kafka();
    setKafkaSecurityProtocol(s, 'SASL_SSL');
    expect([s.auth, s.ssl.enabled]).toEqual(['password', true]);
    expect(needsUser(s)).toBe(true);
    s.kafka.saslMechanism = 'OAUTHBEARER';
    expect(needsUser(s)).toBe(false);
    expect(needsPassword(s)).toBe(true);
    setKafkaSecurityProtocol(s, 'SSL');
    expect([s.auth, s.ssl.enabled, kafkaSecurityProtocol(s)]).toEqual(['none', true, 'SSL']);
  });

  it('shows the first bootstrap server and how many follow', () => {
    expect(describeEndpoint(kafka((s) => (s.kafka.bootstrapServers = ' b1:9092, b2:9092 ,b3:9092')))).toBe('b1:9092 +2');
  });

  it('checks bootstrap servers, users and REST URLs', () => {
    const errors = validateDataSource(
      kafka((s) => {
        s.kafka.bootstrapServers = 'b1:9092,b2';
        s.kafka.schemaRegistryUrl = 'registry:8081';
        setKafkaSecurityProtocol(s, 'SASL_PLAINTEXT');
      }),
      [],
    );
    expect(errors['kafka.bootstrapServers']).toBe('“b2” is not host:port, e.g. broker-1:9092.');
    expect(errors['kafka.schemaRegistryUrl']).toBe('Schema Registry URL must start with http:// or https://.');
    expect(errors.user).toBe('User is required.');
    expect(validateDataSource(kafka((s) => (s.kafka.bootstrapServers = ' ')), [])['kafka.bootstrapServers']).toBe('Bootstrap servers are required.');
  });

  it('parses host:port with IPv6 addresses', () => {
    expect(parseHostPort('[::1]:9092')).toEqual({ host: '::1', port: 9092 });
    expect(parseHostPort('broker-1.internal:29092')).toEqual({ host: 'broker-1.internal', port: 29092 });
    expect(parseHostPort('broker:0')).toBeNull();
    expect(parseHostPort('::1:9092')).toBeNull();
  });
});

describe('Kafka client config', () => {
  it('is built from the fields, without secrets', () => {
    const s = kafka((s) => {
      s.kafka.bootstrapServers = 'b1:9092, b2:9092';
      setKafkaSecurityProtocol(s, 'SASL_SSL');
      s.kafka.saslMechanism = 'SCRAM-SHA-512';
    });
    expect(buildConnectionUrl(s)).toBe('bootstrap.servers=b1:9092,b2:9092 security.protocol=SASL_SSL sasl.mechanism=SCRAM-SHA-512');
    expect(buildConnectionUrl(kafka())).toBe('bootstrap.servers=localhost:9092 security.protocol=PLAINTEXT');
  });

  it('fills the fields from client.properties, with the JAAS user and password', () => {
    const text = [
      '# Confluent Cloud',
      'bootstrap.servers=pkc-1.eu-central-1.aws.confluent.cloud:9092',
      'security.protocol=SASL_SSL',
      'sasl.mechanism=PLAIN',
      'sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="KEY1" password="se\\"cret";',
      'client.id=ccloud-java',
      'schema.registry.url=https://psrc-1.confluent.cloud',
      'session.timeout.ms=45000',
    ].join('\n');
    const result = parseConnectionUrl(text, kafka());
    if (!result.ok) throw new Error(result.error);
    expect(result.settings.kafka).toMatchObject({
      bootstrapServers: 'pkc-1.eu-central-1.aws.confluent.cloud:9092',
      saslMechanism: 'PLAIN',
      clientId: 'ccloud-java',
      schemaRegistryUrl: 'https://psrc-1.confluent.cloud',
    });
    expect(kafkaSecurityProtocol(result.settings)).toBe('SASL_SSL');
    expect(result.settings.user).toBe('KEY1');
    expect(result.password).toBe('se"cret');
    expect(result.ignored).toEqual(['session.timeout.ms']);
  });

  it('reads the one-line form it builds and rejects unknown protocols', () => {
    const result = parseConnectionUrl('bootstrap.servers=a:1,b:2 security.protocol=ssl', kafka());
    expect(result.ok && [result.settings.kafka.bootstrapServers, kafkaSecurityProtocol(result.settings)]).toEqual(['a:1,b:2', 'SSL']);
    const wrong = parseConnectionUrl('security.protocol=TLS', kafka());
    expect(!wrong.ok && wrong.error).toContain('Unknown security.protocol “TLS”');
    expect(parseConnectionUrl('nothing here', kafka()).ok).toBe(false);
  });
});

describe('Kafka versions', () => {
  it('names the release of a metadata.version level', () => {
    expect(kafkaReleaseOfMetadataLevel(19)).toBe('3.7');
    expect(kafkaReleaseOfMetadataLevel(21)).toBe('3.9');
    expect(kafkaReleaseOfMetadataLevel(25)).toBe('4.0');
    expect(kafkaReleaseOfMetadataLevel(27)).toBe('4.1');
    expect(kafkaReleaseOfMetadataLevel(30)).toBe('4.1+');
    expect(kafkaReleaseOfMetadataLevel(0)).toBeNull();
  });
});

describe('Kafka produce templates', () => {
  const template = (patch: Partial<KafkaProduceTemplate> = {}): KafkaProduceTemplate => ({
    partition: null,
    key: 'order-${counter}',
    value: '{"id": ${counter}, "at": "${now}"}',
    headers: 'trace-id=${uuid}\n\nsource = test',
    count: 1,
    valueFormat: 'json',
    ...patch,
  });
  const values = { uuid: () => 'u-1', now: new Date('2026-10-24T12:00:00Z'), random: () => 0.5 };

  it('fills placeholders per message and sends JSON compact', () => {
    expect(expandPlaceholders('${counter}/${random}', 2, values)).toBe('3/500000');
    expect(recordOf(template(), 1, values)).toEqual({
      partition: null,
      key: 'order-2',
      value: '{"id":2,"at":"2026-10-24T12:00:00.000Z"}',
      headers: [
        { key: 'trace-id', value: 'u-1' },
        { key: 'source', value: 'test' },
      ],
    });
    expect(recordOf(template({ key: null }), 0, values).key).toBeNull();
  });

  it('checks values, counts, partitions and headers', () => {
    expect(produceProblem(template(), 6)).toBeNull();
    expect(valueProblem('{"a":', 'json')).toBe('Not valid JSON.');
    expect(valueProblem('${counter}', 'int64')).toBeNull();
    expect(valueProblem('1.5', 'int64')).toBe('Int64 values must be whole numbers.');
    expect(produceProblem(template({ count: 0 }), 6)).toBe('Count must be between 1 and 100,000.');
    expect(produceProblem(template({ partition: 6 }), 6)).toBe('Partition must be between 0 and 5.');
    expect(produceProblem(template({ headers: 'oops' }), 6)).toBe('Header line 1 is not name=value.');
    expect(() => parseHeaderLines('=x')).toThrow('Header line 1');
  });
});

describe('Kafka topics', () => {
  it('validates topic names like Kafka', () => {
    expect(topicNameProblem('orders.refunded', ['orders.created'])).toBeNull();
    expect(topicNameProblem('orders created', [])).toBe('Letters, digits, dot, dash and underscore only.');
    expect(topicNameProblem('orders.created', ['orders.created'])).toBe('This topic already exists.');
    expect(topicNameProblem('orders_created', ['orders.created'])).toContain('differs only in . and _');
    expect(topicNameProblem('..', [])).toContain('cannot be named');
  });

  it('labels retention', () => {
    expect(formatDuration(604_800_000)).toBe('7 d');
    expect(formatDuration(5_400_000)).toBe('90 min');
    expect(formatDuration(1500)).toBe('1500 ms');
    expect(retentionLabel({ retentionMs: -1, cleanupPolicy: 'delete' })).toBe('forever');
    expect(retentionLabel({ retentionMs: 604_800_000, cleanupPolicy: 'compact' })).toBe('compact');
    expect(retentionLabel({ retentionMs: 86_400_000, cleanupPolicy: 'compact,delete' })).toBe('1 d · compact');
  });

  it('compares int64 offsets and searches messages', () => {
    expect(compareOffsets('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareOffsets('2', '10')).toBe(-1);
    const payload = (text: string) => ({ text, binary: false, size: text.length, truncated: false, schemaId: null, decoded: null });
    const message: KafkaMessage = { partition: 0, offset: '1', timestamp: 0, key: payload('order-1'), value: payload('{"to":"Alice"}'), headers: [{ key: 'trace', value: 'ABC' }] };
    expect(messageContains(message, 'alice')).toBe(true);
    expect(messageContains(message, 'abc')).toBe(true);
    expect(messageContains(message, 'nobody')).toBe(false);
  });
});

describe('Kafka ACL templates', () => {
  it('lists what a consumer, producer and streams app need', () => {
    expect(aclsFromTemplate('consumer', 'User:app', 'orders', 'app-group').map((a) => `${a.operation} ${a.resourceType} ${a.resourceName}`)).toEqual([
      'READ TOPIC orders',
      'DESCRIBE TOPIC orders',
      'READ GROUP app-group',
    ]);
    expect(aclsFromTemplate('producer', 'User:app', 'orders', '').at(-1)).toMatchObject({ operation: 'IDEMPOTENT_WRITE', resourceType: 'CLUSTER', resourceName: 'kafka-cluster' });
    expect(aclsFromTemplate('streams', 'User:app', 'orders', 'counter')[1]).toMatchObject({ operation: 'ALL', resourceName: 'counter-', patternType: 'PREFIXED' });
    expect(aclTemplateProblem('consumer', 'app', 'orders', 'g')).toContain('type:name');
    expect(aclTemplateProblem('producer', 'User:app', 'orders', '')).toBeNull();
  });
});

describe('Kafka health', () => {
  it('lists offline partitions, missing replicas, lag and failed tasks', () => {
    const overview: KafkaOverview = {
      clusterId: 'c',
      controllerId: 1,
      brokers: [],
      topics: 1,
      partitions: 12,
      replicationFactors: [3],
      underReplicated: [{ topic: 'payments.captured', partition: 7, leader: 3, replicas: [3, 1, 2], isr: [3, 1] }],
      offline: [],
      groups: [
        { id: 'notifier', state: 'Empty', protocolType: 'consumer', members: 0, lagByTopic: { 'emails.outbox': 41 } },
        { id: 'order-service', state: 'Stable', protocolType: 'consumer', members: 2, lagByTopic: { orders: 13, payments: null } },
      ],
      checkedAt: 0,
    };
    const connectors = [{ name: 'es-sink', type: 'sink' as const, className: 'X', state: 'RUNNING' as const, workerId: 'w', trace: null, tasks: [{ id: 1, state: 'FAILED' as const, workerId: 'w', trace: 'boom' }] }];
    expect(kafkaHealth(overview, connectors).map((i) => i.summary)).toEqual(['1 out-of-sync replica', 'max lag 41 · notifier', '1 connector task failed']);
    expect(kafkaHealth({ ...overview, underReplicated: [], groups: [] }, null)).toEqual([]);
  });
});
