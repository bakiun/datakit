<script setup lang="ts">
import { AUTH_METHODS, CONNECTION_TYPES, MYSQL_DRIVERS, PASSWORD_STORAGE } from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import ConnectionUrl from './ConnectionUrl.vue';
import { useForm } from './form';
import SecretField from './SecretField.vue';

/** The General tab of a MySQL or MariaDB data source. */
const form = useForm();
const s = form.settings;
const storageNote = computed(() =>
  s.passwordStorage === 'never' ? 'Asked for on every connect' : s.passwordStorage === 'session' ? 'Kept in memory until VS Code restarts' : '',
);
</script>

<template>
  <div class="section">
    <FormRow label="Connection type" for="f-ctype">
      <select id="f-ctype" v-model="s.connectionType" class="fld select">
        <option v-for="c in CONNECTION_TYPES" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <label for="f-driver" class="inline-label">Driver:</label>
      <select id="f-driver" v-model="s.driver" class="fld select">
        <option v-for="c in MYSQL_DRIVERS" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
    </FormRow>

    <FormRow v-if="s.connectionType === 'tcp'" label="Host" for="f-host">
      <input id="f-host" v-model="s.host" class="fld mono host" :class="{ invalid: form.error('host') }" spellcheck="false" />
      <label for="f-port" class="inline-label">Port:</label>
      <input id="f-port" v-model="s.port" class="fld mono port" :class="{ invalid: form.error('port') }" inputmode="numeric" />
    </FormRow>
    <FormRow v-else label="Socket" for="f-socket">
      <input
        id="f-socket"
        v-model="s.socketPath"
        class="fld mono grow"
        :class="{ invalid: form.error('socketPath') }"
        placeholder="/tmp/mysql.sock"
        spellcheck="false"
      />
    </FormRow>

    <FormRow label="Authentication" for="f-auth">
      <select id="f-auth" v-model="s.auth" class="fld select">
        <option v-for="c in AUTH_METHODS" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
    </FormRow>
    <template v-if="s.auth === 'password'">
      <FormRow label="User" for="f-user">
        <input id="f-user" v-model="s.user" class="fld mono grow" :class="{ invalid: form.error('user') }" spellcheck="false" autocomplete="off" />
      </FormRow>
      <FormRow label="Password" for="f-password">
        <SecretField id="f-password" secret="password" />
        <label for="f-save" class="inline-label">Save:</label>
        <select id="f-save" v-model="s.passwordStorage" class="fld select save">
          <option v-for="c in PASSWORD_STORAGE" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
        <span v-if="storageNote" class="note">{{ storageNote }}</span>
      </FormRow>
    </template>
    <FormRow label="Database" for="f-database">
      <input id="f-database" v-model="s.database" class="fld mono grow" placeholder="optional" spellcheck="false" />
    </FormRow>

    <ConnectionUrl
      placeholder="mysql://user@host:3306/database?ssl-mode=REQUIRED"
      note="Type or paste a URL to fill in the fields. Parameters: ssl-mode, ssl-ca, ssl-cert, ssl-key, socket and mysql2 options such as connectTimeout. Passwords are kept in VS Code Secret Storage."
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
