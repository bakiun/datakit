<script setup lang="ts">
import type { RedisEdit, RedisKeyDetail, RedisText } from '@datakit/core';
import { computed, ref, watch } from 'vue';
import CodeView from '../components/CodeView.vue';
import { isModShortcut, isSubmitShortcut, modShortcutLabel } from '../components/shortcuts';
import { describeValue, isBinary, textOf } from './format';

/**
 * A string value in an editor. JSON is shown indented and saved back compact when the stored value was compact;
 * `raw`, shared with the item detail, shows it as stored. Switching the view keeps what was typed. ⌘S or ⌘Enter
 * (Ctrl+S or Ctrl+Enter off macOS) saves. Binary values and values cut short (over 1 MiB) are shown read-only.
 */
const props = defineProps<{ detail: RedisKeyDetail; value: RedisText; truncated: boolean; readOnly: boolean; keepTtl: boolean; busy: boolean }>();
const emit = defineEmits<{ edit: [edit: RedisEdit] }>();
const raw = defineModel<boolean>('raw', { required: true });

const original = computed(() => textOf(props.value));
const json = computed(() => describeValue(props.value).json);
const view = computed({
  get: (): 'json' | 'text' => (json.value !== undefined && !raw.value ? 'json' : 'text'),
  set: (next) => (raw.value = next === 'text'),
});
const draft = ref('');
const error = ref<string | null>(null);
const locked = computed(() => props.readOnly || props.truncated || isBinary(props.value));
const originalIn = (shown: 'json' | 'text') => (shown === 'json' && json.value !== undefined ? JSON.stringify(json.value, null, 2) : original.value);
const shownOriginal = computed(() => originalIn(view.value));
const clean = computed(() => draft.value === shownOriginal.value);
const saveKeys = modShortcutLabel('S');

function reset(): void {
  draft.value = shownOriginal.value;
  error.value = null;
}
watch(() => props.value, reset, { immediate: true });
// An untouched value is shown as the other view shows it; an edited one stays as typed, indented when it is JSON.
watch(view, (shown, before) => {
  if (draft.value === originalIn(before)) draft.value = originalIn(shown);
  else if (shown === 'json') {
    try {
      draft.value = JSON.stringify(JSON.parse(draft.value), null, 2);
    } catch {
      // Not JSON yet: kept as typed.
    }
  }
});
watch(draft, () => (error.value = null));

/** Writes the draft; in the JSON view it must parse, unless `asText` saves it exactly as typed. */
function save(asText = false): void {
  if (locked.value || clean.value || props.busy) return;
  let value = draft.value;
  if (view.value === 'json' && !asText) {
    try {
      const parsed: unknown = JSON.parse(value);
      // Stored on one line, saved on one line.
      if (!original.value.includes('\n')) value = JSON.stringify(parsed);
    } catch {
      error.value = 'This is not valid JSON.';
      return;
    }
  }
  error.value = null;
  emit('edit', { kind: 'setString', key: props.detail.key, value, ttl: props.detail.ttl, keepTtl: props.keepTtl });
}

function onEditorKey(event: KeyboardEvent): void {
  if (isModShortcut(event, 's') || isSubmitShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    save();
  }
}
</script>

<template>
  <div class="string-value">
    <div class="bar">
      <label class="view">
        View as
        <select v-model="view" class="sel" aria-label="View as" :disabled="json === undefined">
          <option value="json">JSON</option>
          <option value="text">Text</option>
        </select>
      </label>
      <span class="note">{{ detail.length?.toLocaleString('en-US') }} bytes</span>
      <span v-if="truncated" class="warning">Showing the first 1 MiB; values this long cannot be edited here.</span>
      <span v-else-if="isBinary(value)" class="warning">The value is binary; it is shown as \x escapes and cannot be edited here.</span>
    </div>
    <div class="editor" @keydown.capture="onEditorKey">
      <CodeView v-model="draft" :language="view === 'json' ? 'json' : 'text'" :read-only="locked" label="String value" />
    </div>
    <div class="actions">
      <button
        type="button"
        class="btn small primary"
        :disabled="locked || clean || busy"
        :title="readOnly ? 'The data source is read-only' : `Save value (${saveKeys})`"
        @click="save()"
      >
        Save value
      </button>
      <button type="button" class="btn small" :disabled="clean || busy" @click="reset">Revert</button>
      <span v-if="error" class="error" role="alert">
        {{ error }} <button type="button" class="link" @click="save(true)">Save it as text</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.string-value {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px;
}
.bar,
.actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}
.view {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
}
.sel {
  height: 26px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  font: inherit;
}
.editor {
  flex: 1;
  min-height: 120px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}
.warning {
  color: var(--vscode-editorWarning-foreground);
}
.error {
  color: var(--vscode-errorForeground);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
}
.link:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}
.btn.small {
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
}
.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.actions {
  padding-bottom: 8px;
}
</style>
