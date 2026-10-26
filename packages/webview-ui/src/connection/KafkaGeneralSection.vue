<script setup lang="ts">
import {
  KAFKA_SASL_MECHANISMS,
  KAFKA_SECURITY_PROTOCOLS,
  kafkaSecurityProtocol,
  needsUser,
  PASSWORD_STORAGE,
  setKafkaSecurityProtocol,
  type KafkaSecurityProtocol,
} from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import ConnectionUrl from './ConnectionUrl.vue';
import { useForm } from './form';
import SecretField from './SecretField.vue';

/**
 * The General tab of a Kafka data source. The security protocol is not stored: it sets SASL (`auth`) and TLS, whose
 * certificate checks are on the SSL / SASL tab.
 */
const form = useForm();
const s = form.settings;
const k = s.kafka;
const protocol = computed({
  get: () => kafkaSecurityProtocol(s),
  set: (value: KafkaSecurityProtocol) => setKafkaSecurityProtocol(s, value),
});
const sasl = computed(() => s.auth !== 'none');
const token = computed(() => k.saslMechanism === 'OAUTHBEARER');
const storageNote = computed(() =>
  s.passwordStorage === 'never' ? 'Asked for on every connect' : s.passwordStorage === 'session' ? 'Kept in memory until VS Code restarts' : '',
);
</script>

<template>
  <div class="section">
    <FormRow label="Bootstrap servers" for="f-bootstrap">
      <input
        id="f-bootstrap"
        v-model="k.bootstrapServers"
        class="fld mono grow"
        :class="{ invalid: form.error('kafka.bootstrapServers') }"
        placeholder="broker-1:9092,broker-2:9092"
        spellcheck="false"
      />
    </FormRow>
    <FormRow label="Security protocol" for="f-protocol">
      <select id="f-protocol" v-model="protocol" class="fld select">
        <option v-for="c in KAFKA_SECURITY_PROTOCOLS" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <template v-if="sasl">
        <label for="f-mechanism" class="inline-label">SASL:</label>
        <select id="f-mechanism" v-model="k.saslMechanism" class="fld select">
          <option v-for="c in KAFKA_SASL_MECHANISMS" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
      </template>
      <span v-if="s.ssl.enabled" class="note">Certificate checks are on the SSL / SASL tab</span>
    </FormRow>
    <FormRow v-if="needsUser(s)" label="User" for="f-user">
      <input id="f-user" v-model="s.user" class="fld mono grow" :class="{ invalid: form.error('user') }" spellcheck="false" autocomplete="off" />
    </FormRow>
    <FormRow v-if="sasl" :label="token ? 'Token' : 'Password'" for="f-password">
      <SecretField id="f-password" secret="password" />
      <label for="f-save" class="inline-label">Save:</label>
      <select id="f-save" v-model="s.passwordStorage" class="fld select save">
        <option v-for="c in PASSWORD_STORAGE" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
      <span v-if="storageNote" class="note">{{ storageNote }}</span>
    </FormRow>
    <FormRow label="Schema Registry" for="f-registry">
      <input
        id="f-registry"
        v-model="k.schemaRegistryUrl"
        class="fld mono grow"
        :class="{ invalid: form.error('kafka.schemaRegistryUrl') }"
        placeholder="https://schema-registry.internal:8081 (optional)"
        spellcheck="false"
      />
    </FormRow>
    <FormRow label="Kafka Connect" for="f-connect">
      <input
        id="f-connect"
        v-model="k.connectUrl"
        class="fld mono grow"
        :class="{ invalid: form.error('kafka.connectUrl') }"
        placeholder="http://connect.internal:8083 (optional)"
        spellcheck="false"
      />
    </FormRow>
    <FormRow label="ksqlDB" for="f-ksql">
      <input
        id="f-ksql"
        v-model="k.ksqlDbUrl"
        class="fld mono grow"
        :class="{ invalid: form.error('kafka.ksqlDbUrl') }"
        placeholder="http://ksqldb.internal:8088 (optional)"
        spellcheck="false"
      />
    </FormRow>
    <FormRow label="Client ID" for="f-client">
      <input id="f-client" v-model="k.clientId" class="fld mono grow" placeholder="datakit" spellcheck="false" />
    </FormRow>

    <ConnectionUrl
      label="Client config"
      multiline
      placeholder="bootstrap.servers=broker-1:9092 security.protocol=SASL_SSL"
      note="Paste a client.properties file to fill in the fields: bootstrap.servers, security.protocol, sasl.mechanism, sasl.jaas.config, client.id and schema.registry.url. Passwords are kept in VS Code Secret Storage."
    />
  </div>
</template>

<style scoped>
.save {
  flex: 0 1 150px;
}
</style>
