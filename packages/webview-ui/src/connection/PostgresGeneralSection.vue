<script setup lang="ts">
import { PASSWORD_STORAGE, POSTGRES_AUTH_METHODS } from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import ConnectionUrl from './ConnectionUrl.vue';
import { useForm } from './form';
import SecretField from './SecretField.vue';

/** The General tab of a PostgreSQL data source. TLS and the SSH tunnel are on the SSH / SSL tab. */
const form = useForm();
const s = form.settings;
const storageNote = computed(() =>
  s.passwordStorage === 'never' ? 'Asked for on every connect' : s.passwordStorage === 'session' ? 'Kept in memory until VS Code restarts' : '',
);
</script>

<template>
  <div class="section">
    <FormRow label="Host" for="f-host">
      <input id="f-host" v-model="s.host" class="fld mono host" :class="{ invalid: form.error('host') }" spellcheck="false" />
      <label for="f-port" class="inline-label">Port:</label>
      <input id="f-port" v-model="s.port" class="fld mono port" :class="{ invalid: form.error('port') }" inputmode="numeric" />
    </FormRow>

    <FormRow label="Authentication" for="f-auth">
      <select id="f-auth" v-model="s.auth" class="fld select">
        <option v-for="c in POSTGRES_AUTH_METHODS" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
    </FormRow>
    <FormRow label="User" for="f-user">
      <input id="f-user" v-model="s.user" class="fld mono grow" :class="{ invalid: form.error('user') }" spellcheck="false" autocomplete="off" />
    </FormRow>
    <FormRow v-if="s.auth === 'password'" label="Password" for="f-password">
      <SecretField id="f-password" secret="password" />
      <label for="f-save" class="inline-label">Save:</label>
      <select id="f-save" v-model="s.passwordStorage" class="fld select save">
        <option v-for="c in PASSWORD_STORAGE" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <span v-if="storageNote" class="note">{{ storageNote }}</span>
    </FormRow>
    <FormRow label="Database" for="f-database">
      <input id="f-database" v-model="s.database" class="fld mono grow" placeholder="the user's name when left empty" spellcheck="false" />
      <span class="note">Opened first in the tree; other databases connect when you open them</span>
    </FormRow>

    <ConnectionUrl
      placeholder="postgresql://user@host:5432/database?sslmode=require"
      note="Type or paste a URL to fill in the fields: postgres:// or postgresql://, sslmode, sslrootcert, sslcert, sslkey, connect_timeout and pg options such as application_name or options (-c search_path=shop). Passwords are kept in VS Code Secret Storage."
    />
  </div>
</template>

<style scoped>
.host {
  flex: 3 1 220px;
}
.port {
  flex: 0 1 90px;
}
.save {
  flex: 0 1 150px;
}
</style>
