<script setup lang="ts">
import {
  cloneSettings,
  createDataSourceSettings,
  ENGINES,
  ENVIRONMENTS,
  needsPassword,
  sectionOf,
  switchEngine,
  validateDataSource,
  type EditorHostMessage,
  type EditorState,
  type EditorWebviewMessage,
  type EngineId,
  type FileField,
  type FormSection,
  type SecretKey,
  type SecretPatch,
} from '@datakit/core';
import { computed, onMounted, onUnmounted, provide, reactive, ref } from 'vue';
import FormRow from '../components/FormRow.vue';
import Icon from '../components/Icon.vue';
import { onHostMessage, postToHost } from '../host';
import AdvancedSection from './AdvancedSection.vue';
import { assignSettings, formKey } from './form';
import GeneralSection from './GeneralSection.vue';
import KafkaGeneralSection from './KafkaGeneralSection.vue';
import MongoGeneralSection from './MongoGeneralSection.vue';
import RedisGeneralSection from './RedisGeneralSection.vue';
import OptionsSection from './OptionsSection.vue';
import PostgresGeneralSection from './PostgresGeneralSection.vue';
import SshSslSection from './SshSslSection.vue';

const SECTIONS: readonly { id: FormSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ssh', label: 'SSH / SSL' },
  { id: 'options', label: 'Options' },
  { id: 'advanced', label: 'Advanced' },
];
/** Kafka has no SSH tunnel; its second tab holds TLS. */
const sectionLabel = (id: FormSection, label: string) => (id === 'ssh' && settings.engine === 'kafka' ? 'SSL / SASL' : label);
const NAME_PLACEHOLDERS: Record<EngineId, string> = {
  mysql: 'e.g. shop-staging',
  postgres: 'e.g. billing-staging',
  redis: 'e.g. cache-staging',
  kafka: 'e.g. events-staging',
  mongodb: 'e.g. catalog-staging',
};
const SECRET_KEYS: readonly SecretKey[] = ['password', 'sshPassword', 'sshPassphrase'];

const loaded = ref(false);
const mode = ref<EditorState['mode']>('new');
const settings = reactive(createDataSourceSettings());
const secrets = reactive<Record<SecretKey, string>>({ password: '', sshPassword: '', sshPassphrase: '' });
const touched = reactive<Record<SecretKey, boolean>>({ password: false, sshPassword: false, sshPassphrase: false });
const storedSecrets = ref<Record<SecretKey, boolean>>({ password: false, sshPassword: false, sshPassphrase: false });
const otherNames = ref<string[]>([]);
const section = ref<FormSection>('general');
const showErrors = ref(false);
const busy = ref<'test' | 'save' | null>(null);
const status = ref<{ ok: boolean; message: string } | null>(null);

const errors = computed(() => validateDataSource(settings, otherNames.value));
const error = (field: string) => (showErrors.value ? errors.value[field] : undefined);
const sectionsWithErrors = computed(() => new Set(showErrors.value ? Object.keys(errors.value).map(sectionOf) : []));
const isEdit = computed(() => mode.value === 'edit');

const post = (message: EditorWebviewMessage) => postToHost(message);

provide(formKey, {
  settings,
  secrets,
  touched,
  storedSecrets,
  errors,
  error,
  browse: (field: FileField) => post({ type: 'browse', field, current: filePath(field) }),
});

function filePath(field: FileField): string {
  const [group, key] = field.split('.') as ['ssh' | 'ssl', string];
  return (settings[group] as unknown as Record<string, string>)[key] ?? '';
}

function setFilePath(field: FileField, path: string): void {
  const [group, key] = field.split('.') as ['ssh' | 'ssl', string];
  (settings[group] as unknown as Record<string, string>)[key] = path;
}

function load(state: EditorState): void {
  assignSettings(settings, state.settings);
  mode.value = state.mode;
  storedSecrets.value = state.storedSecrets;
  otherNames.value = state.otherNames;
  for (const key of SECRET_KEYS) {
    secrets[key] = '';
    touched[key] = false;
  }
  showErrors.value = false;
  loaded.value = true;
}

/** Secrets to send: all relevant ones for a new data source, only retyped ones when editing. */
function secretPatch(): SecretPatch {
  const used: Record<SecretKey, boolean> = {
    password: needsPassword(settings),
    sshPassword: settings.ssh.enabled && settings.ssh.auth === 'password',
    sshPassphrase: settings.ssh.enabled && settings.ssh.auth === 'key',
  };
  const patch: SecretPatch = {};
  for (const key of SECRET_KEYS) if (used[key] && (!isEdit.value || touched[key])) patch[key] = secrets[key];
  return patch;
}

function test(): void {
  busy.value = 'test';
  status.value = null;
  post({ type: 'test', settings: cloneSettings(settings), secrets: secretPatch() });
}

function save(close: boolean): void {
  showErrors.value = true;
  const field = Object.keys(errors.value)[0];
  if (field) {
    section.value = sectionOf(field) ?? section.value;
    status.value = { ok: false, message: errors.value[field]! };
    return;
  }
  busy.value = 'save';
  status.value = null;
  post({ type: 'save', settings: cloneSettings(settings), secrets: secretPatch(), close });
}

/** A new data source can change its engine; the fields start again from that engine's defaults. */
function pickEngine(engine: EngineId): void {
  if (isEdit.value || settings.engine === engine) return;
  assignSettings(settings, switchEngine(settings, engine));
  section.value = 'general';
  showErrors.value = false;
  status.value = null;
}

/** Any edit makes the last test result stale. */
function edited(): void {
  if (!busy.value) status.value = null;
}

const stop = onHostMessage<EditorHostMessage>((message) => {
  switch (message.type) {
    case 'init':
      load(message.state);
      break;
    case 'testResult':
      busy.value = null;
      status.value = { ok: message.ok, message: message.message };
      break;
    case 'saved':
      load(message.state);
      busy.value = null;
      status.value = { ok: true, message: 'Saved.' };
      break;
    case 'saveFailed':
      busy.value = null;
      status.value = { ok: false, message: message.message };
      break;
    case 'fileSelected':
      setFilePath(message.field, message.path);
      edited();
      break;
  }
});
onMounted(() => post({ type: 'ready' }));
onUnmounted(stop);
</script>

<template>
  <main v-if="loaded" class="editor" @input="edited" @change="edited">
    <h1>{{ isEdit ? 'Edit data source' : 'New data source' }}</h1>

    <div role="tablist" aria-label="Engine" class="engines">
      <button
        v-for="engine in ENGINES"
        :key="engine.id"
        type="button"
        role="tab"
        class="engine"
        :aria-selected="settings.engine === engine.id"
        :disabled="isEdit && settings.engine !== engine.id"
        @click="pickEngine(engine.id)"
      >
        <Icon :name="engine.id" :size="18" class="engine-icon" />
        {{ engine.name }}
      </button>
    </div>

    <div class="identity">
      <FormRow label="Name" for="c-name">
        <input
          id="c-name"
          v-model="settings.name"
          class="fld grow"
          :class="{ invalid: error('name') }"
          :placeholder="NAME_PLACEHOLDERS[settings.engine]"
          spellcheck="false"
          autofocus
        />
      </FormRow>
      <FormRow label="Comment" for="c-comment">
        <input id="c-comment" v-model="settings.comment" class="fld grow" placeholder="Optional" />
      </FormRow>
      <FormRow label="Environment" for="c-env">
        <select id="c-env" v-model="settings.environment" class="fld env">
          <option v-for="c in ENVIRONMENTS" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </FormRow>
    </div>

    <div class="settings">
      <div role="tablist" aria-label="Settings" class="sections">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          type="button"
          role="tab"
          class="section-tab"
          :class="{ 'has-error': sectionsWithErrors.has(s.id) }"
          :aria-selected="section === s.id"
          @click="section = s.id"
        >
          {{ sectionLabel(s.id, s.label) }}
        </button>
      </div>
      <template v-if="section === 'general'">
        <RedisGeneralSection v-if="settings.engine === 'redis'" />
        <KafkaGeneralSection v-else-if="settings.engine === 'kafka'" />
        <MongoGeneralSection v-else-if="settings.engine === 'mongodb'" />
        <PostgresGeneralSection v-else-if="settings.engine === 'postgres'" />
        <GeneralSection v-else />
      </template>
      <SshSslSection v-else-if="section === 'ssh'" />
      <OptionsSection v-else-if="section === 'options'" />
      <AdvancedSection v-else />
    </div>

    <footer class="footer">
      <button type="button" class="lnk" :disabled="busy !== null" @click="test">Test Connection</button>
      <span v-if="busy === 'test'" role="status" class="note">Connecting…</span>
      <span v-else-if="busy === 'save'" role="status" class="note">Saving…</span>
      <span v-else-if="status" :role="status.ok ? 'status' : 'alert'" class="result" :class="status.ok ? 'ok' : 'error'">
        <Icon :name="status.ok ? 'check' : 'error'" :size="14" />{{ status.message }}
      </span>
      <div class="buttons">
        <button type="button" class="btn" :disabled="busy === 'save'" @click="post({ type: 'cancel' })">Cancel</button>
        <button v-if="isEdit" type="button" class="btn" :disabled="busy !== null" @click="save(false)">Apply</button>
        <button type="button" class="btn btn-primary" :disabled="busy !== null" @click="save(true)">
          {{ isEdit ? 'Save' : 'Save & connect' }}
        </button>
      </div>
    </footer>
  </main>
</template>

<style scoped>
.editor {
  max-width: 920px;
  padding: 24px 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.engines {
  display: flex;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.engine {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: var(--vscode-panelTitle-inactiveForeground);
  font: inherit;
  cursor: pointer;
}
.engine:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}
.engine[aria-selected='true'] {
  color: var(--vscode-panelTitle-activeForeground);
  box-shadow: inset 0 -2px 0 var(--vscode-panelTitle-activeBorder);
}
.engine:disabled {
  cursor: default;
  opacity: 0.4;
}
.engine-icon {
  color: var(--vscode-charts-orange);
}
.identity {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.env {
  flex: 0 1 220px;
}
.settings {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  background: var(--vscode-sideBar-background);
}
.sections {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  padding: 0 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.section-tab {
  height: 34px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--vscode-panelTitle-inactiveForeground);
  font: inherit;
  cursor: pointer;
}
.section-tab[aria-selected='true'] {
  color: var(--vscode-panelTitle-activeForeground);
  box-shadow: inset 0 -2px 0 var(--vscode-panelTitle-activeBorder);
}
.section-tab.has-error {
  color: var(--vscode-errorForeground);
}
.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}
.result {
  display: flex;
  align-items: center;
  gap: 6px;
}
.result.ok {
  color: var(--vscode-testing-iconPassed);
}
.result.error {
  color: var(--vscode-errorForeground);
}
.buttons {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
</style>
