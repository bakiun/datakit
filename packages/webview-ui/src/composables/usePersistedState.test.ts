import type { WebviewSavedState } from '@datakit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive, ref } from 'vue';
import { fingerprint, keepText, SavedStateStore, savedValue, usePersistedState, type StateStorage } from './usePersistedState';

/** A host that keeps what the page saves, like VS Code's getState and setState. */
function memoryStorage(initial?: unknown): StateStorage & { saved: unknown; writes: number } {
  const storage = {
    saved: initial,
    writes: 0,
    get: () => storage.saved,
    set(state: WebviewSavedState) {
      storage.saved = state;
      storage.writes++;
    },
  };
  return storage;
}

const parts = (storage: { saved: unknown }) => (storage.saved as WebviewSavedState).parts;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the saved state store', () => {
  it('reads parts by version only', () => {
    const store = new SavedStateStore(memoryStorage({ parts: { tab: { v: 2, data: 'structure' }, bad: 'x' } }));
    expect(store.read('tab', 2)).toBe('structure');
    expect(store.read('tab', 1)).toBeUndefined();
    expect(store.read('bad', 1)).toBeUndefined();
  });

  it('writes once after a pause, with the value as it is then', () => {
    const storage = memoryStorage();
    const store = new SavedStateStore(storage, { delay: 300, maxWait: 1500 });
    let text = 'a';
    for (let i = 0; i < 5; i++) {
      text += 'b';
      store.changed('script', 1, () => text);
      vi.advanceTimersByTime(100);
    }
    // Typing never waits for a write: nothing is written while the changes keep coming.
    expect(storage.writes).toBe(0);
    text = 'final';
    vi.advanceTimersByTime(300);
    expect(storage.writes).toBe(1);
    expect(parts(storage)).toEqual({ script: { v: 1, data: 'final' } });
  });

  it('writes at least every maxWait while changes keep coming', () => {
    const storage = memoryStorage();
    const store = new SavedStateStore(storage, { delay: 300, maxWait: 1000 });
    for (let i = 0; i < 20; i++) {
      store.changed('script', 1, () => i);
      vi.advanceTimersByTime(100);
    }
    expect(storage.writes).toBe(2);
  });

  it('keeps parts it was not told about, and drops parts that are too large or undefined', () => {
    const storage = memoryStorage({ parts: { other: { v: 1, data: { keep: true } }, gone: { v: 1, data: 1 } } });
    const store = new SavedStateStore(storage);
    store.changed('big', 1, () => 'x'.repeat(50), 20);
    store.changed('gone', 1, () => undefined);
    store.changed('small', 1, () => ({ a: 1 }));
    store.flush();
    expect(parts(storage)).toEqual({ other: { v: 1, data: { keep: true } }, small: { v: 1, data: { a: 1 } } });
  });

  it('saves the panel it was rendered as at once, and keeps the one the state already names', () => {
    const fresh = memoryStorage();
    new SavedStateStore(fresh, { panel: { dataSourceId: 'a' } });
    expect((fresh.saved as WebviewSavedState).panel).toEqual({ dataSourceId: 'a' });

    const reloaded = memoryStorage({ panel: { dataSourceId: 'a', database: 3 }, parts: {} });
    const store = new SavedStateStore(reloaded, { panel: { dataSourceId: 'a', database: 0 } });
    expect(reloaded.writes).toBe(0);
    expect(store.panel()).toEqual({ dataSourceId: 'a', database: 3 });
    store.updatePanel({ database: 5 });
    expect((reloaded.saved as WebviewSavedState).panel).toEqual({ dataSourceId: 'a', database: 5 });
  });

  it('works on when the host cannot keep state', () => {
    const store = new SavedStateStore({
      get: () => {
        throw new Error('no state');
      },
      set: () => {
        throw new Error('no state');
      },
    });
    store.changed('x', 1, () => 1);
    expect(() => store.flush()).not.toThrow();
  });
});

describe('usePersistedState', () => {
  it('saves nothing until the page restored, then every change after a pause', async () => {
    const storage = memoryStorage({ parts: { view: { v: 1, data: { tab: 'structure', draft: 'saved' } } } });
    const store = new SavedStateStore(storage);
    const scope = effectScope();
    const tab = ref('data');
    const draft = ref('');
    const part = scope.run(() =>
      usePersistedState(
        'view',
        {
          version: 1,
          value: () => ({ tab: tab.value, draft: draft.value }),
          validate: (saved) => {
            const o = savedValue.object(saved);
            return o && { tab: savedValue.oneOf(o.tab, ['data', 'structure'] as const) ?? 'data', draft: savedValue.string(o.draft) ?? '' };
          },
        },
        store,
      ),
    )!;

    // The page starts with its defaults; they must not replace what was saved before it restores.
    tab.value = 'data';
    draft.value = 'typed before init';
    await nextTick();
    vi.advanceTimersByTime(5000);
    expect(storage.writes).toBe(0);

    const restored = part.restore();
    expect(restored).toEqual({ tab: 'structure', draft: 'saved' });
    tab.value = restored!.tab;
    draft.value = restored!.draft;
    await nextTick();
    vi.advanceTimersByTime(400);
    expect(parts(storage)?.view).toEqual({ v: 1, data: { tab: 'structure', draft: 'saved' } });

    draft.value = 'edited';
    await nextTick();
    expect(parts(storage)?.view?.data).toEqual({ tab: 'structure', draft: 'saved' });
    vi.advanceTimersByTime(400);
    expect(parts(storage)?.view?.data).toEqual({ tab: 'structure', draft: 'edited' });

    // Unmounting writes what is pending at once.
    draft.value = 'last';
    await nextTick();
    scope.stop();
    expect(parts(storage)?.view?.data).toEqual({ tab: 'structure', draft: 'last' });
  });

  it('follows changes deep inside reactive objects', async () => {
    const storage = memoryStorage();
    const store = new SavedStateStore(storage);
    const form = reactive({ ssh: { host: '' } });
    const scope = effectScope();
    const part = scope.run(() => usePersistedState('form', { version: 1, value: () => ({ form }), validate: () => undefined }, store))!;
    part.restore();
    form.ssh.host = 'bastion';
    await nextTick();
    part.flush();
    expect(parts(storage)?.form?.data).toEqual({ form: { ssh: { host: 'bastion' } } });
    scope.stop();
  });

  it('restores nothing from another version or what validate refuses', () => {
    const store = new SavedStateStore(memoryStorage({ parts: { a: { v: 1, data: 1 }, b: { v: 2, data: 'x' } } }));
    const scope = effectScope();
    scope.run(() => {
      expect(usePersistedState('a', { version: 2, value: () => 1, validate: () => 1 }, store).restore()).toBeUndefined();
      const throwing = usePersistedState(
        'b',
        {
          version: 2,
          value: () => 'x',
          validate: () => {
            throw new Error('bad');
          },
        },
        store,
      );
      expect(throwing.restore()).toBeUndefined();
    });
    scope.stop();
  });
});

describe('helpers', () => {
  it('keeps text only whole', () => {
    expect(keepText('abc', 3)).toBe('abc');
    expect(keepText('abcd', 3)).toBeUndefined();
  });

  it('reads saved values strictly', () => {
    expect(savedValue.strings(['a', 1, 'bbbb', 'c'], 2, 3)).toEqual(['a', 'c']);
    expect(savedValue.integer(-1)).toBeUndefined();
    expect(savedValue.integer(2)).toBe(2);
    expect(savedValue.oneOf('x', ['a', 'b'])).toBeUndefined();
  });

  it('fingerprints values', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
