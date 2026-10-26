<script setup lang="ts">
import { DEFAULT_QUERY_TIMEOUT_SECONDS, PAGE_SIZES, TRANSACTION_MODES } from '@datakit/core';
import { computed } from 'vue';
import FormRow from '../components/FormRow.vue';
import { useForm } from './form';

const form = useForm();
const o = form.settings.options;
const isRedis = computed(() => form.settings.engine === 'redis');
const initPlaceholder = computed(() => (form.settings.engine === 'postgres' ? "SET TIME ZONE 'Europe/Istanbul';" : "SET time_zone = '+03:00';"));
</script>

<template>
  <div class="section options">
    <label v-if="isRedis" class="check"><input v-model="o.readOnly" type="checkbox" /> Read-only — block edits and commands that write</label>
    <label v-else class="check"><input v-model="o.readOnly" type="checkbox" /> Read-only — block INSERT, UPDATE, DELETE and DDL</label>
    <label class="check"><input v-model="o.autoConnect" type="checkbox" /> Connect when VS Code starts</label>
    <FormRow v-if="!isRedis" label="Transaction mode" for="o-tx" :label-width="160">
      <select id="o-tx" v-model="o.autoCommit" class="fld select">
        <option v-for="c in TRANSACTION_MODES" :key="c.label" :value="c.value">{{ c.label }}</option>
      </select>
      <span class="note">Used by query consoles</span>
    </FormRow>
    <FormRow label="Default page size" for="o-page" :label-width="160">
      <select id="o-page" v-model="o.pageSize" class="fld select">
        <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
      </select>
      <span class="note">{{ isRedis ? 'Keys and value items loaded at a time in the key browser' : 'Rows per page in data views' }}</span>
    </FormRow>
    <FormRow v-if="!isRedis" label="Query timeout (s)" for="o-timeout" :label-width="160">
      <input
        id="o-timeout"
        v-model="o.queryTimeout"
        class="fld mono select"
        :class="{ invalid: form.error('options.queryTimeout') }"
        :placeholder="String(DEFAULT_QUERY_TIMEOUT_SECONDS)"
        inputmode="numeric"
      />
      <span class="note">0 means no limit</span>
    </FormRow>
    <FormRow v-if="!isRedis" label="Run on connect" for="o-init" :label-width="160" top>
      <textarea id="o-init" v-model="o.initSql" class="fld mono init" :placeholder="initPlaceholder" spellcheck="false" />
    </FormRow>
  </div>
</template>

<style scoped>
.options {
  gap: 12px;
}
.select {
  flex: 0 1 200px;
}
.init {
  flex: 1 1 300px;
  height: 64px;
  padding: 6px 8px;
  resize: vertical;
}
</style>
