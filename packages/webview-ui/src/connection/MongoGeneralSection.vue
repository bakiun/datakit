<script setup lang="ts">
import { AUTH_METHODS, MONGO_CONNECTION_FORMATS, PASSWORD_STORAGE } from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import ConnectionUrl from './ConnectionUrl.vue';
import { useForm } from './form';
import SecretField from './SecretField.vue';

/** The General tab of a MongoDB data source. TLS and the SSH tunnel are on the SSH / SSL tab. */
const form = useForm();
const s = form.settings;
const m = s.mongo;
const storageNote = computed(() =>
  s.passwordStorage === 'never' ? 'Asked for on every connect' : s.passwordStorage === 'session' ? 'Kept in memory until VS Code restarts' : '',
);
</script>

<template>
  <div class="section">
    <FormRow label="Connection" for="f-format">
      <select id="f-format" v-model="m.srv" class="fld select">
        <option v-for="c in MONGO_CONNECTION_FORMATS" :key="String(c.value)" :value="c.value">{{ c.label }}</option>
      </select>
      <span v-if="m.srv" class="note">Hosts and ports come from the DNS SRV records; TLS is on by default</span>
    </FormRow>
    <FormRow :label="m.srv ? 'Host' : 'Hosts'" for="f-hosts">
      <input
        id="f-hosts"
        v-model="m.hosts"
        class="fld mono grow"
        :class="{ invalid: form.error('mongo.hosts') }"
        :placeholder="m.srv ? 'cluster0.example.mongodb.net' : 'mongo-1:27017,mongo-2:27017'"
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
      <FormRow label="Auth database" for="f-authsource">
        <input id="f-authsource" v-model="m.authSource" class="fld mono grow" placeholder="admin" spellcheck="false" />
      </FormRow>
    </template>
    <FormRow label="Database" for="f-database">
      <input id="f-database" v-model="s.database" class="fld mono grow" placeholder="optional; opened first in the tree" spellcheck="false" />
    </FormRow>
    <FormRow v-if="!m.srv" label="Replica set" for="f-replicaset">
      <input id="f-replicaset" v-model="m.replicaSet" class="fld mono grow" placeholder="optional, e.g. rs0" spellcheck="false" />
    </FormRow>

    <ConnectionUrl
      placeholder="mongodb://user@host:27017/database?authSource=admin"
      note="Type or paste a connection string to fill in the fields: mongodb:// or mongodb+srv://, the database as the path, authSource, replicaSet, tls, tlsCAFile and driver options such as appName as parameters. Passwords are kept in VS Code Secret Storage."
    />
  </div>
</template>

<style scoped>
.save {
  flex: 0 1 150px;
}
</style>
