import { describe, expect, it } from 'vitest';
import { consumersToSave, MAX_SAVED_DRAFT, MAX_SAVED_TOPICS, readSavedConsumers, readSavedTopic, readSavedWorkspace, workspaceToSave } from './savedState';
import type { ProduceDraft } from './workspace';

const draft = (value = '{}'): ProduceDraft => ({ partition: 'auto', valueFormat: 'json', key: 'k', keyNull: false, value, headers: '', count: '1' });

describe('the saved Kafka workspace', () => {
  it('round-trips the place and what was typed per topic', () => {
    const filters = new Map([['orders', [{ id: 1, type: 'text' as const, from: 'paid', to: '' }]], ['empty', []]]);
    const produce = new Map([['orders', draft()]]);
    const saved = JSON.parse(JSON.stringify(workspaceToSave('topics', 'orders', { filters, produce }))) as unknown;
    expect(readSavedWorkspace(saved)).toEqual({
      section: 'topics',
      topic: 'orders',
      filters: { orders: [{ id: 1, type: 'text', from: 'paid', to: '' }] },
      produce: { orders: draft() },
    });
  });

  it('keeps the last topics only, and no draft too long to keep whole', () => {
    const produce = new Map<string, ProduceDraft>(Array.from({ length: MAX_SAVED_TOPICS + 5 }, (_, i) => [`t${i}`, draft()]));
    produce.set('big', draft('x'.repeat(MAX_SAVED_DRAFT + 1)));
    const saved = workspaceToSave('overview', null, { filters: new Map(), produce });
    expect(Object.keys(saved.produce)).toHaveLength(MAX_SAVED_TOPICS);
    expect(saved.produce.big).toBeUndefined();
    expect(saved.produce.t24).toBeDefined();
    expect(saved.produce.t0).toBeUndefined();
  });

  it('drops what does not read and keeps the rest', () => {
    const restored = readSavedWorkspace({
      section: 'nowhere',
      topic: 42,
      filters: { orders: [{ id: 1, type: 'bogus', from: '', to: '' }, { id: 2, type: 'partition', from: '0', to: '' }], bad: 'x' },
      produce: { orders: { ...draft(), valueFormat: 'xml' }, ok: draft() },
    });
    expect(restored).toEqual({ section: undefined, topic: undefined, filters: { orders: [{ id: 2, type: 'partition', from: '0', to: '' }] }, produce: { ok: draft() } });
    expect(readSavedWorkspace('x')).toBeUndefined();
  });

  it('reads the topic tab and the consumers selection', () => {
    expect(readSavedTopic({ topic: 'orders', tab: 'settings', produceOpen: true })).toEqual({ topic: 'orders', tab: 'settings', produceOpen: true });
    expect(readSavedTopic({ topic: 'orders', tab: 'nope' })?.tab).toBeUndefined();
    expect(readSavedTopic({ tab: 'settings' })).toBeUndefined();
    const consumers = consumersToSave('billing', new Set(['orders\u00000']));
    expect(readSavedConsumers(JSON.parse(JSON.stringify(consumers)))).toEqual({ picked: 'billing', selected: ['orders\u00000'] });
    expect(readSavedConsumers({ picked: 3, selected: [1] })).toEqual({ picked: null, selected: [] });
  });
});
