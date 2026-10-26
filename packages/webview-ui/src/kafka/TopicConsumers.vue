<script setup lang="ts">
import { computed, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { groupState, lagText, num } from './format';
import { useWorkspace } from './workspace';

/** The consumer groups with offsets on the topic, and their lag on it. */
const props = defineProps<{ topic: string }>();
const ws = useWorkspace();
const s = ws.state;

const groups = computed(() =>
  (s.groups ?? s.overview?.overview.groups ?? [])
    .filter((g) => props.topic in g.lagByTopic)
    .map((g) => ({ id: g.id, state: groupState(g.state), raw: g.state, members: g.members, lag: g.lagByTopic[props.topic] ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id)),
);

onMounted(() => ws.load('groups'));
</script>

<template>
  <div class="topic-consumers">
    <p v-if="s.errors.groups" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.groups }}</p>
    <div class="table-box">
      <table class="grid">
        <thead>
          <tr>
            <th scope="col">GROUP</th>
            <th scope="col">STATE</th>
            <th scope="col" class="num">MEMBERS</th>
            <th scope="col" class="num">LAG</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in groups" :key="g.id">
            <td>{{ g.id }}</td>
            <td><span class="chip" :class="`tone-${g.state.tone}`" :title="g.raw">{{ g.state.label }}</span></td>
            <td class="num">{{ num(g.members) }}</td>
            <td class="num" :class="g.lag ? 't-warn' : 't-ok'">{{ lagText(g.lag) }}</td>
            <td class="num"><button type="button" class="lnk" @click="ws.openGroup(g.id)">Adjust offsets</button></td>
          </tr>
        </tbody>
      </table>
      <p v-if="!groups.length" class="empty-state">{{ !s.groups && s.loading.groups ? 'Reading the consumer groups…' : 'No consumer group reads this topic.' }}</p>
    </div>
  </div>
</template>

<style scoped>
.topic-consumers {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 20px 16px;
}
.lnk {
  font-size: 12px;
}
</style>
