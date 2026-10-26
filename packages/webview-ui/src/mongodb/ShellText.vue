<script setup lang="ts">
import { computed } from 'vue';
import { highlightShell } from './shellSyntax';

/** Shell-syntax text colored like the code editor, without an editor: for document cards and short snippets. */
const props = defineProps<{ text: string }>();
const spans = computed(() => highlightShell(props.text));
</script>

<template>
  <code class="shell-text"><template v-for="(s, i) in spans" :key="i"><span v-if="s.className" :class="s.className">{{ s.text }}</span><template v-else>{{ s.text }}</template></template></code>
</template>

<style scoped>
.shell-text {
  font-family: var(--vscode-editor-font-family);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
