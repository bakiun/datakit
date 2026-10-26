<script setup lang="ts">
import { buildConnectionUrl, getEngine, parseConnectionUrl } from '@datakit/core';
import { computed, ref } from 'vue';
import FormRow from '../components/FormRow.vue';
import { assignSettings, useForm } from './form';

/**
 * The connection URL under the General tab. It follows the fields; while it has focus, what the user types fills them.
 * `multiline` takes pasted text with line breaks, such as a Kafka client.properties file.
 */
withDefaults(defineProps<{ placeholder: string; note: string; label?: string; multiline?: boolean }>(), { label: 'URL' });

const form = useForm();
const s = form.settings;
const builtUrl = computed(() => buildConnectionUrl(s));
const editingUrl = ref(false);
const typedUrl = ref('');
const urlValue = computed(() => (editingUrl.value ? typedUrl.value : builtUrl.value));
const rows = computed(() => Math.min(8, Math.max(1, urlValue.value.split('\n').length)));
const urlMessage = ref<{ kind: 'error' | 'warning' | 'info'; text: string } | null>(null);

function startUrlEdit(): void {
  editingUrl.value = true;
  typedUrl.value = builtUrl.value;
}

function applyUrl(event: Event): void {
  typedUrl.value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  if (!typedUrl.value.trim()) {
    urlMessage.value = null;
    return;
  }
  const result = parseConnectionUrl(typedUrl.value, s);
  if (!result.ok) {
    urlMessage.value = { kind: 'error', text: result.error };
    return;
  }
  assignSettings(s, result.settings);
  if (result.password !== undefined) {
    form.secrets.password = result.password;
    form.touched.password = true;
  }
  if (result.ignored.length) {
    urlMessage.value = { kind: 'warning', text: `Ignored, not supported by ${getEngine(s.engine).driverLibrary}: ${result.ignored.join(', ')}.` };
  } else if (result.password !== undefined) {
    urlMessage.value = { kind: 'info', text: 'The password from the URL is used; the URL itself never shows it.' };
  } else {
    urlMessage.value = null;
  }
}

function endUrlEdit(): void {
  editingUrl.value = false;
  // The field now shows the URL built from the fields, so an error about the typed text no longer applies.
  if (urlMessage.value?.kind === 'error') urlMessage.value = null;
}
</script>

<template>
  <div class="url">
    <FormRow :label="label" for="f-url" top>
      <div class="url-value">
        <textarea
          v-if="multiline"
          id="f-url"
          class="fld mono multiline"
          :class="{ invalid: urlMessage?.kind === 'error' }"
          :value="urlValue"
          :rows="rows"
          :placeholder="placeholder"
          spellcheck="false"
          autocomplete="off"
          @focus="startUrlEdit"
          @input="applyUrl"
          @blur="endUrlEdit"
        />
        <input
          v-else
          id="f-url"
          class="fld mono"
          :class="{ invalid: urlMessage?.kind === 'error' }"
          :value="urlValue"
          :placeholder="placeholder"
          spellcheck="false"
          autocomplete="off"
          @focus="startUrlEdit"
          @input="applyUrl"
          @blur="endUrlEdit"
        />
        <span v-if="urlMessage" class="url-message" :class="urlMessage.kind" role="status">{{ urlMessage.text }}</span>
        <span class="note">{{ note }}</span>
      </div>
    </FormRow>
  </div>
</template>

<style scoped>
.url {
  padding-top: 6px;
  margin-top: 4px;
  border-top: 1px solid var(--vscode-panel-border);
}
.url-value {
  flex: 1 1 400px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.multiline {
  height: auto;
  padding-top: 5px;
  padding-bottom: 5px;
  line-height: 16px;
  resize: none;
}
.url-message {
  font-size: 12px;
}
.url-message.error {
  color: var(--vscode-errorForeground);
}
.url-message.warning {
  color: var(--vscode-editorWarning-foreground);
}
.url-message.info {
  color: var(--vscode-descriptionForeground);
}
</style>
