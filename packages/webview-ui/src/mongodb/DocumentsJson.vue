<script setup lang="ts">
import type { MongoDocument } from '@datakit/core';
import { computed } from 'vue';
import IconButton from '../components/IconButton.vue';
import { useCollection } from './collection';
import { documentsArray, plural } from './format';
import ShellCode from './ShellCode.vue';

/** The documents on show as one array in shell syntax, read-only, with Copy. */
const props = defineProps<{ documents: MongoDocument[] }>();
const col = useCollection();
const text = computed(() => documentsArray(props.documents));
</script>

<template>
  <div class="documents-json">
    <div class="code">
      <ShellCode :model-value="text" read-only label="Documents as an array in shell syntax" />
    </div>
    <IconButton icon="copy" class="copy" label="Copy the array" @click="col.copy(text, plural(documents.length, 'document'))" />
  </div>
</template>

<style scoped>
.documents-json {
  position: relative;
  height: 100%;
  min-height: 0;
}
.code {
  height: 100%;
}
.copy {
  position: absolute;
  top: 6px;
  right: 14px;
  background: var(--vscode-editor-background);
}
</style>
