<script setup lang="ts">
import { SSH_AUTH_METHODS, SSL_MODES } from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import FileInput from './FileInput.vue';
import { useForm } from './form';
import SecretField from './SecretField.vue';

const form = useForm();
const ssh = form.settings.ssh;
const ssl = form.settings.ssl;

const SSL_NOTES = {
  require: 'Encrypts the connection without checking the certificate.',
  'verify-ca': 'Checks the server certificate against the CA.',
  'verify-full': 'Also checks that the certificate matches the host name.',
} as const;
const sslNote = computed(() => SSL_NOTES[ssl.mode]);
/** Kafka brokers hand out their own addresses, which one SSH tunnel cannot reach; this tab only has TLS for Kafka. */
const kafka = computed(() => form.settings.engine === 'kafka');
</script>

<template>
  <div class="section">
    <template v-if="!kafka">
      <label class="check"><input v-model="ssh.enabled" type="checkbox" /> Use SSH tunnel</label>
      <div v-if="ssh.enabled" class="nested">
        <FormRow label="Proxy host" for="s-host" :label-width="108">
          <input
            id="s-host"
            v-model="ssh.host"
            class="fld mono host"
            :class="{ invalid: form.error('ssh.host') }"
            placeholder="bastion.example.com"
            spellcheck="false"
          />
          <label for="s-port" class="inline-label">Port:</label>
          <input id="s-port" v-model="ssh.port" class="fld mono port" :class="{ invalid: form.error('ssh.port') }" placeholder="22" />
        </FormRow>
        <FormRow label="Proxy user" for="s-user" :label-width="108">
          <input
            id="s-user"
            v-model="ssh.user"
            class="fld mono grow"
            :class="{ invalid: form.error('ssh.user') }"
            placeholder="deploy"
            spellcheck="false"
          />
        </FormRow>
        <FormRow label="Auth type" for="s-auth" :label-width="108">
          <select id="s-auth" v-model="ssh.auth" class="fld select">
            <option v-for="c in SSH_AUTH_METHODS" :key="c.value" :value="c.value">{{ c.label }}</option>
          </select>
          <span v-if="ssh.auth === 'agent'" class="note">Uses the agent at SSH_AUTH_SOCK.</span>
        </FormRow>
        <template v-if="ssh.auth === 'key'">
          <FormRow label="Private key" for="s-key" :label-width="108">
            <FileInput id="s-key" v-model="ssh.privateKeyPath" field="ssh.privateKeyPath" placeholder="~/.ssh/id_ed25519" />
          </FormRow>
          <FormRow label="Passphrase" for="s-passphrase" :label-width="108">
            <SecretField id="s-passphrase" secret="sshPassphrase" empty-text="optional" flex="1 1 220px" />
          </FormRow>
        </template>
        <FormRow v-else-if="ssh.auth === 'password'" label="Password" for="s-password" :label-width="108">
          <SecretField id="s-password" secret="sshPassword" flex="1 1 220px" />
        </FormRow>
      </div>

      <div class="divider" />
    </template>

    <label class="check"><input v-model="ssl.enabled" type="checkbox" /> Use SSL / TLS</label>
    <span v-if="kafka" class="note">Follows the security protocol on the General tab; SASL is chosen there too.</span>
    <div v-if="ssl.enabled" class="nested">
      <FormRow label="Mode" for="t-mode" :label-width="108">
        <select id="t-mode" v-model="ssl.mode" class="fld select">
          <option v-for="c in SSL_MODES" :key="c.value" :value="c.value">{{ c.label }}</option>
        </select>
        <span class="note">{{ sslNote }}</span>
      </FormRow>
      <FormRow label="CA file" for="t-ca" :label-width="108">
        <FileInput
          id="t-ca"
          v-model="ssl.caFile"
          field="ssl.caFile"
          :placeholder="ssl.mode === 'require' ? 'optional' : '~/certs/ca.pem'"
        />
      </FormRow>
      <FormRow label="Client cert" for="t-cert" :label-width="108">
        <FileInput id="t-cert" v-model="ssl.certFile" field="ssl.certFile" placeholder="optional" />
      </FormRow>
      <FormRow label="Client key" for="t-key" :label-width="108">
        <FileInput id="t-key" v-model="ssl.keyFile" field="ssl.keyFile" placeholder="optional" />
      </FormRow>
    </div>
  </div>
</template>

<style scoped>
.nested {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-left: 22px;
}
.host {
  flex: 3 1 220px;
}
.port {
  flex: 0 1 80px;
}
.divider {
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-panel-border);
}
</style>
