<script setup lang="ts">
import { getEngine } from '@datakit/core';
import { computed, nextTick, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { useForm } from './form';

const form = useForm();
const s = form.settings;
const engine = computed(() => getEngine(s.engine));
const keyInputs = ref<HTMLInputElement[]>([]);
/** Messages for the rows, shown under the table once the user tried to save. */
const rowErrors = computed(() =>
  s.properties.flatMap((_, i) => [form.error(`properties.${i}.key`), form.error(`properties.${i}.value`)].filter((e) => e !== undefined)),
);

async function add(): Promise<void> {
  s.properties.push({ key: '', value: '' });
  await nextTick();
  keyInputs.value[s.properties.length - 1]?.focus();
}
</script>

<template>
  <div class="section advanced">
    <span class="note">Driver / client properties passed as-is to {{ engine.driverLibrary }}. They also appear as URL parameters.</span>
    <datalist id="driver-options">
      <option v-for="(type, name) in engine.driverOptions" :key="name" :value="name">{{ type }}</option>
    </datalist>
    <div class="table mono" role="table" aria-label="Driver properties">
      <div class="head" role="row">
        <span role="columnheader">property</span>
        <span role="columnheader">value</span>
        <span class="actions" />
      </div>
      <div v-for="(p, i) in s.properties" :key="i" class="prop" role="row">
        <input
          ref="keyInputs"
          v-model="p.key"
          class="cell key"
          :class="{ invalid: form.error(`properties.${i}.key`) }"
          :aria-label="`Property ${i + 1} name`"
          :title="form.error(`properties.${i}.key`)"
          list="driver-options"
          spellcheck="false"
        />
        <input
          v-model="p.value"
          class="cell value"
          :class="{ invalid: form.error(`properties.${i}.value`) }"
          :aria-label="`Property ${i + 1} value`"
          :title="form.error(`properties.${i}.value`)"
          :placeholder="engine.driverOptions[p.key.trim()]"
          spellcheck="false"
        />
        <span class="actions">
          <button type="button" class="icon-btn" :aria-label="`Remove ${p.key || 'property'}`" title="Remove" @click="s.properties.splice(i, 1)">
            <Icon name="close" :size="14" />
          </button>
        </span>
      </div>
      <div v-if="!s.properties.length" class="empty">No properties. The driver defaults apply.</div>
    </div>
    <ul v-if="rowErrors.length" class="row-errors" role="alert">
      <li v-for="message in rowErrors" :key="message">{{ message }}</li>
    </ul>
    <button type="button" class="btn add" @click="add"><Icon name="plus" :size="14" /> Add property</button>
  </div>
</template>

<style scoped>
.advanced {
  gap: 8px;
}
.table {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}
.head,
.prop {
  display: flex;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.prop:last-child {
  border-bottom: 0;
}
.head {
  background: var(--vscode-editorWidget-background);
}
.head > span:not(.actions) {
  flex: 1;
  padding: 6px 10px;
}
.head > span + span,
.prop > * + * {
  border-left: 1px solid var(--vscode-panel-border);
}
.cell {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 0;
  outline: none;
  background: transparent;
  font: inherit;
}
.cell:focus {
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
.cell.invalid {
  box-shadow: inset 0 0 0 1px var(--vscode-inputValidation-errorBorder);
}
.key {
  color: var(--vscode-symbolIcon-propertyForeground);
}
.value {
  color: var(--vscode-debugTokenExpression-string);
}
.actions {
  flex: 0 0 34px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty {
  padding: 8px 10px;
  color: var(--vscode-descriptionForeground);
}
.add {
  align-self: flex-start;
}
.row-errors {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}
.cell::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
</style>
