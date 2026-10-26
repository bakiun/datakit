<script setup lang="ts">
import { PASSWORD_STORAGE, REDIS_AUTH_METHODS } from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import ConnectionUrl from './ConnectionUrl.vue';
import { useForm } from './form';
import SecretField from './SecretField.vue';

/** The General tab of a Redis data source. TLS is the same switch as on the SSH / SSL tab, which has its details. */
const form = useForm();
const s = form.settings;
const storageNote = computed(() =>
  s.passwordStorage === 'never' ? 'Asked for on every connect' : s.passwordStorage === 'session' ? 'Kept in memory until VS Code restarts' : '',
);
const tls = computed({
  get: () => (s.ssl.enabled ? 'on' : 'off'),
  set: (value: string) => (s.ssl.enabled = value === 'on'),
});
</script>

<template>
  <div class="section">
    <FormRow label="Host" for="f-host">
      <input id="f-host" v-model="s.host" class="fld mono host" :class="{ invalid: form.error('host') }" spellcheck="false" />
      <label for="f-port" class="inline-label">Port:</label>
      <input id="f-port" v-model="s.port" class="fld mono port" :class="{ invalid: form.error('port') }" inputmode="numeric" />
    </FormRow>
    <FormRow label="Database index" for="f-database">
      <input id="f-database" v-model="s.database" class="fld mono index" :class="{ invalid: form.error('database') }" inputmode="numeric" />
      <span class="note">0–15 on most servers; the key browser can switch to any of them</span>
    </FormRow>
    <FormRow label="Authentication" for="f-auth">
      <select id="f-auth" v-model="s.auth" class="fld select">
        <option v-for="c in REDIS_AUTH_METHODS" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
    </FormRow>
    <FormRow v-if="s.auth === 'acl'" label="User" for="f-user">
      <input
        id="f-user"
        v-model="s.user"
        class="fld mono grow"
        :class="{ invalid: form.error('user') }"
        placeholder="default"
        spellcheck="false"
        autocomplete="off"
      />
    </FormRow>
    <FormRow v-if="s.auth !== 'none'" label="Password" for="f-password">
      <SecretField id="f-password" secret="password" />
      <label for="f-save" class="inline-label">Save:</label>
      <select id="f-save" v-model="s.passwordStorage" class="fld select save">
        <option v-for="c in PASSWORD_STORAGE" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <span v-if="storageNote" class="note">{{ storageNote }}</span>
    </FormRow>
    <FormRow label="TLS" for="f-tls">
      <select id="f-tls" v-model="tls" class="fld tls">
        <option value="off">Off</option>
        <option value="on">On</option>
      </select>
      <span v-if="s.ssl.enabled" class="note">Certificate checks are on the SSH / SSL tab</span>
    </FormRow>

    <ConnectionUrl
      placeholder="redis://user@host:6379/0"
      note="Type or paste a URL to fill in the fields: redis:// or rediss:// for TLS, the database index as the path and node-redis options such as connectTimeout as parameters. Passwords are kept in VS Code Secret Storage."
    />
  </div>
</template>

<style scoped>
.host {
  flex: 3 1 220px;
}
.port,
.index {
  flex: 0 1 90px;
}
.save {
  flex: 0 1 150px;
}
.tls {
  flex: 0 1 120px;
}
</style>
