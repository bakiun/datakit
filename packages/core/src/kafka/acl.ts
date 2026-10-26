import type { KafkaAcl, KafkaAclOperation, KafkaAclPatternType, KafkaAclResourceType } from './types';

export type KafkaAclTemplate = 'consumer' | 'producer' | 'streams';

export const KAFKA_ACL_TEMPLATES: readonly { value: KafkaAclTemplate; label: string; groupLabel: string | null }[] = [
  { value: 'consumer', label: 'Consumer', groupLabel: 'Consumer group' },
  { value: 'producer', label: 'Producer', groupLabel: null },
  { value: 'streams', label: 'Kafka Streams app', groupLabel: 'Application id' },
];

/** The resource name Kafka uses for the cluster in ACLs. */
export const KAFKA_CLUSTER_RESOURCE = 'kafka-cluster';

/**
 * The ACLs a client of the kind needs, all ALLOW from any host. `group` is the consumer group, or the application id
 * of a Kafka Streams app, whose internal topics start with `<application id>-`.
 */
export function aclsFromTemplate(template: KafkaAclTemplate, principal: string, topic: string, group: string): KafkaAcl[] {
  const acl = (operation: KafkaAclOperation, resourceType: KafkaAclResourceType, resourceName: string, patternType: KafkaAclPatternType = 'LITERAL'): KafkaAcl => ({
    principal,
    host: '*',
    resourceType,
    resourceName,
    patternType,
    operation,
    permission: 'ALLOW',
  });
  switch (template) {
    case 'consumer':
      return [acl('READ', 'TOPIC', topic), acl('DESCRIBE', 'TOPIC', topic), acl('READ', 'GROUP', group)];
    case 'producer':
      return [acl('WRITE', 'TOPIC', topic), acl('DESCRIBE', 'TOPIC', topic), acl('IDEMPOTENT_WRITE', 'CLUSTER', KAFKA_CLUSTER_RESOURCE)];
    case 'streams':
      return [acl('READ', 'TOPIC', topic), acl('ALL', 'TOPIC', `${group}-`, 'PREFIXED'), acl('READ', 'GROUP', group)];
  }
}

/** Why the template cannot be applied yet; null when it can. */
export function aclTemplateProblem(template: KafkaAclTemplate, principal: string, topic: string, group: string): string | null {
  if (!/^[^:\s]+:\S+$/.test(principal.trim())) return 'The principal is type:name, e.g. User:order-service.';
  if (!topic.trim()) return 'Name the topic.';
  if (template !== 'producer' && !group.trim()) return template === 'streams' ? 'Name the application id.' : 'Name the consumer group.';
  return null;
}

/** Identifies an ACL, e.g. for selections; two ACLs with the same key are the same binding. */
export function aclKey(acl: KafkaAcl): string {
  return [acl.principal, acl.host, acl.resourceType, acl.resourceName, acl.patternType, acl.operation, acl.permission].join('\u0000');
}
