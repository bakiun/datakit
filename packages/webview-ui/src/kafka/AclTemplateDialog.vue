<script setup lang="ts">
import { aclsFromTemplate, aclTemplateProblem, KAFKA_ACL_TEMPLATES, type KafkaAclTemplate } from '@datakit/core';
import { computed, ref } from 'vue';
import { plural } from './format';
import KafkaDialog from './KafkaDialog.vue';
import { useWorkspace } from './workspace';

/** Creates the ACLs a consumer, producer or Kafka Streams app needs, from a few names. */
const props = defineProps<{ topics: string[] }>();
const emit = defineEmits<{ close: [] }>();
const ws = useWorkspace();

if (!ws.state.topics && !ws.state.loading.topics) ws.load('topics');

const template = ref<KafkaAclTemplate>('consumer');
const principal = ref('User:');
const topic = ref(props.topics[0] ?? '');
const group = ref('');

const groupLabel = computed(() => KAFKA_ACL_TEMPLATES.find((t) => t.value === template.value)?.groupLabel ?? null);
const problem = computed(() => aclTemplateProblem(template.value, principal.value, topic.value, group.value));
const acls = computed(() => aclsFromTemplate(template.value, principal.value.trim(), topic.value.trim(), group.value.trim()));
/** The problem shows once something has been typed, not for the empty form. */
const shownProblem = computed(() => (principal.value.trim() !== 'User:' || topic.value || group.value ? problem.value : null));

const create = () => ws.write({ kind: 'createAcls', acls: acls.value }, { quiet: true });
</script>

<template>
  <KafkaDialog title="Create ACLs from template" :primary="`Create ${plural(acls.length, 'ACL')}`" :disabled="!!problem" :action="create" @close="emit('close')">
    <div class="row">
      <label class="field">
        Template
        <select v-model="template" class="fld">
          <option v-for="t in KAFKA_ACL_TEMPLATES" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </label>
      <label class="field principal">
        Principal
        <input v-model="principal" class="fld mono" placeholder="User:order-service" spellcheck="false" autocomplete="off" />
      </label>
    </div>
    <div class="row">
      <label class="field">
        Topic
        <input v-model="topic" class="fld mono" list="acl-topics" spellcheck="false" autocomplete="off" />
        <datalist id="acl-topics">
          <option v-for="t in topics" :key="t" :value="t" />
        </datalist>
      </label>
      <label v-if="groupLabel" class="field">
        {{ groupLabel }}
        <input v-model="group" class="fld mono" spellcheck="false" autocomplete="off" />
      </label>
    </div>
    <span v-if="shownProblem" class="t-error problem">{{ shownProblem }}</span>
    <span class="caps">Will create {{ plural(acls.length, 'ACL') }}</span>
    <div class="preview mono">
      <span v-for="(a, i) in acls" :key="i">
        {{ a.permission }} <span class="op">{{ a.operation }}</span> on {{ a.resourceType }} <span class="c-name">{{ a.resourceName || '…' }}</span>&#32;<span class="t-muted">({{ a.patternType }})</span>
      </span>
    </div>
  </KafkaDialog>
</template>

<style scoped>
.principal {
  flex: 2 1 220px !important;
}
.problem {
  font-size: 12px;
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid var(--k-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}
.op {
  font-weight: 600;
}
</style>
