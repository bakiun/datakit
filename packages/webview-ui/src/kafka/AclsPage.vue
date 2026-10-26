<script setup lang="ts">
import { aclKey, type KafkaAcl } from '@datakit/core';
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import AclTemplateDialog from './AclTemplateDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { num, plural } from './format';
import { useWorkspace } from './workspace';

/** The cluster's ACLs; selected ones can be deleted, new ones come from a template. */
const ws = useWorkspace();
const s = ws.state;
/** Rows drawn at most; the filter narrows a larger list. */
const MAX_ROWS = 1000;

const filter = ref('');
const selected = ref(new Set<string>());
const dialog = ref<'template' | 'delete' | null>(null);

const readOnly = computed(() => s.init!.readOnly);
const all = computed(() => s.acls?.list ?? []);
const rows = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const list = needle ? all.value.filter((a) => [a.principal, a.resourceName, a.resourceType, a.operation, a.host].some((x) => x.toLowerCase().includes(needle))) : all.value;
  return [...list].sort((a, b) => a.principal.localeCompare(b.principal) || a.resourceType.localeCompare(b.resourceType) || a.resourceName.localeCompare(b.resourceName));
});
const shown = computed(() => rows.value.slice(0, MAX_ROWS));
const chosen = computed((): KafkaAcl[] => all.value.filter((a) => selected.value.has(aclKey(a))));
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((a) => selected.value.has(aclKey(a))));

function toggle(acl: KafkaAcl): void {
  const next = new Set(selected.value);
  const key = aclKey(acl);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allShownSelected.value ? new Set() : new Set(shown.value.map(aclKey));
}

async function remove() {
  const result = await ws.write({ kind: 'deleteAcls', acls: chosen.value }, { quiet: true });
  if (result.ok) selected.value = new Set();
  return result;
}

onMounted(() => ws.load('acls'));
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Access control</h1>
      <input v-if="s.acls?.list" v-model="filter" class="fld filter" aria-label="Filter ACLs" placeholder="Filter by principal or resource" spellcheck="false" />
      <div class="actions">
        <IconButton icon="reload" label="Read the ACLs again" :disabled="s.loading.acls" @click="ws.load('acls')" />
        <template v-if="!readOnly && s.acls?.list">
          <button type="button" class="btn danger-text" :disabled="!chosen.length" @click="dialog = 'delete'">Delete selected ({{ chosen.length }})</button>
          <button type="button" class="btn btn-primary" @click="dialog = 'template'">Create from template…</button>
        </template>
      </div>
    </header>
    <p v-if="s.errors.acls" class="error-line pad" role="alert"><Icon name="error" :size="14" /> {{ s.errors.acls }}</p>
    <p v-if="s.acls && s.acls.list === null" class="empty-state pad">
      This cluster has no authorizer, so ACLs are not enforced: every client may do everything. Set <span class="mono">authorizer.class.name</span> on the
      brokers to use them.
    </p>
    <div v-else class="table-box list">
      <table class="grid">
        <thead>
          <tr>
            <th v-if="!readOnly" scope="col" class="tick"><input type="checkbox" aria-label="Select all ACLs" :checked="allShownSelected" :disabled="!shown.length" @change="toggleAll" /></th>
            <th scope="col">PRINCIPAL</th>
            <th scope="col">RESOURCE</th>
            <th scope="col">NAME</th>
            <th scope="col">PATTERN</th>
            <th scope="col">OPERATION</th>
            <th scope="col">PERMISSION</th>
            <th scope="col">HOST</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(a, i) in shown" :key="aclKey(a)" :class="{ checked: selected.has(aclKey(a)) }">
            <td v-if="!readOnly" class="tick"><input type="checkbox" :aria-label="`Select ACL ${i + 1}`" :checked="selected.has(aclKey(a))" @change="toggle(a)" /></td>
            <td>{{ a.principal }}</td>
            <td>{{ a.resourceType }}</td>
            <td class="c-name">{{ a.resourceName }}</td>
            <td class="t-muted">{{ a.patternType }}</td>
            <td>{{ a.operation }}</td>
            <td><span class="chip" :class="a.permission === 'DENY' ? 'tone-error' : 'tone-ok'">{{ a.permission }}</span></td>
            <td class="t-muted">{{ a.host }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!s.acls" class="empty-state">{{ s.loading.acls ? 'Reading the ACLs…' : '' }}</p>
      <p v-else-if="!rows.length" class="empty-state">{{ all.length ? 'No ACL matches the filter.' : 'The cluster has no ACLs yet.' }}</p>
      <p v-else-if="rows.length > shown.length" class="empty-state">Showing {{ num(shown.length) }} of {{ num(rows.length) }} ACLs. Filter to narrow them down.</p>
    </div>

    <AclTemplateDialog v-if="dialog === 'template'" :topics="(s.topics ?? []).filter((t) => !t.internal).map((t) => t.name)" @close="dialog = null" />
    <ConfirmDialog
      v-else-if="dialog === 'delete'"
      :title="`Delete ${plural(chosen.length, 'ACL')}`"
      :text="`Deletes the selected ${plural(chosen.length, 'ACL')}. Clients that rely on them lose that access at once.`"
      primary="Delete"
      :action="remove"
      @close="dialog = null"
    />
  </section>
</template>

<style scoped>
.filter {
  flex: 0 1 260px;
  margin-left: 12px;
}
.pad {
  padding: 0 20px 8px;
}
.list {
  flex: 1;
  min-height: 0;
  margin: 0 20px 16px;
}
</style>
