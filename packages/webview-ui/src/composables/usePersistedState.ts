import type { WebviewSavedPart, WebviewSavedState } from '@datakit/core';
import { getCurrentScope, onScopeDispose, watch } from 'vue';
import { getHostState, renderedPanel, setHostState } from '../host';

/**
 * The page's state kept with VS Code's `setState`, so a reload of the page, or of the window, comes back where it was.
 * Each part of a page keeps its own entry, with a version: a part saved in another shape is not restored. Writes
 * wait for a pause, so typing never waits for them, and go out at once when the page is hidden or unloads.
 * VS Code stores this as plain text: no part may hold a password or token.
 */

export interface StateStorage {
  get(): unknown;
  set(state: WebviewSavedState): void;
}

export interface StoreOptions {
  /** Pause after the last change before writing, in ms. */
  delay?: number;
  /** Longest wait for a write while changes keep coming, in ms. */
  maxWait?: number;
  /** Which panel this is, when the state does not say yet. */
  panel?: unknown;
}

const DEFAULT_DELAY = 300;
const DEFAULT_MAX_WAIT = 1500;
/** The largest part kept, as JSON; a larger one is dropped rather than slowing every write down. */
const DEFAULT_MAX_PART = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

interface Dirty {
  version: number;
  value: () => unknown;
  maxLength: number;
}

export class SavedStateStore {
  private readonly state: { panel?: unknown; parts: Record<string, WebviewSavedPart> };
  private readonly dirty = new Map<string, Dirty>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstChange = 0;
  private panelChanged = false;
  private readonly delay: number;
  private readonly maxWait: number;

  constructor(
    private readonly storage: StateStorage,
    options: StoreOptions = {},
  ) {
    this.delay = options.delay ?? DEFAULT_DELAY;
    this.maxWait = options.maxWait ?? DEFAULT_MAX_WAIT;
    let saved: unknown;
    try {
      saved = storage.get();
    } catch {
      saved = undefined;
    }
    const parts: Record<string, WebviewSavedPart> = {};
    if (isObject(saved) && isObject(saved.parts)) {
      for (const [key, part] of Object.entries(saved.parts)) {
        if (isObject(part) && typeof part.v === 'number') parts[key] = { v: part.v, data: part.data };
      }
    }
    this.state = { parts };
    // The state says which panel this is once it has been saved; that is newer than what the page was rendered with.
    const panel = isObject(saved) && isObject(saved.panel) ? saved.panel : options.panel;
    if (panel !== undefined) {
      this.state.panel = panel;
      if (!isObject(saved) || saved.panel === undefined) {
        this.panelChanged = true;
        this.flush();
      }
    }
  }

  /** Which panel this is, as the extension's serializer reads it. */
  panel(): unknown {
    return this.state.panel;
  }

  /** Changes part of the panel's identity, e.g. the Redis database it shows; written at once. */
  updatePanel(patch: Record<string, unknown>): void {
    const next = { ...(isObject(this.state.panel) ? this.state.panel : {}), ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state.panel)) return;
    this.state.panel = next;
    this.panelChanged = true;
    this.flush();
  }

  /** What a part was saved with, if it was saved with `version`. */
  read(key: string, version: number): unknown {
    const part = this.state.parts[key];
    return part && part.v === version ? part.data : undefined;
  }

  /** Notes that a part changed; its value is read when the write goes out, so it is the latest. */
  changed(key: string, version: number, value: () => unknown, maxLength = DEFAULT_MAX_PART): void {
    this.dirty.set(key, { version, value, maxLength });
    const now = Date.now();
    if (this.timer === undefined) this.firstChange = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delay, this.firstChange + this.maxWait - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Writes the changed parts now. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty.size && !this.panelChanged) return;
    for (const [key, { version, value, maxLength }] of this.dirty) {
      let json: string | undefined;
      try {
        const data = value();
        json = data === undefined ? undefined : JSON.stringify(data);
      } catch {
        json = undefined;
      }
      if (json === undefined || json.length > maxLength) delete this.state.parts[key];
      else this.state.parts[key] = { v: version, data: JSON.parse(json) as unknown };
    }
    this.dirty.clear();
    this.panelChanged = false;
    try {
      this.storage.set(JSON.parse(JSON.stringify(this.state)) as WebviewSavedState);
    } catch {
      // A host that cannot keep state, e.g. a page opened without VS Code; the page works on without it.
    }
  }
}

let store: SavedStateStore | undefined;

/** The page's store, bound to the VS Code host; `startSavedState` creates it when the page starts. */
export function savedStateStore(): SavedStateStore {
  if (!store) {
    store = new SavedStateStore({ get: getHostState, set: setHostState }, { panel: renderedPanel() });
    const flush = () => store?.flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
  return store;
}

/** Saves which panel this is as soon as the page starts, so the panel comes back even when nothing else changes. */
export function startSavedState(): void {
  savedStateStore();
}

export interface PersistedPart<T> {
  /**
   * What an earlier load of the page kept, once it passed `validate`; undefined when nothing fits. Saving starts with
   * this call, so a page that restores late (e.g. after its `init`) never overwrites the saved state with its empty
   * start.
   */
  restore(): T | undefined;
  /** Writes now instead of after the pause. */
  flush(): void;
}

export interface PersistOptions<T> {
  /** Bumped whenever the shape of the part changes; a part saved with another version is not restored. */
  version: number;
  /** What to keep, read when the write goes out; undefined removes the part. */
  value: () => T | undefined;
  /** Turns what was saved into the part, dropping what does not fit; undefined when nothing is usable. */
  validate: (saved: unknown) => T | undefined;
  /** The longest JSON the part may take; a larger part is not kept. */
  maxLength?: number;
}

/** One part of the page's saved state; see SavedStateStore. Call it in `setup`: it watches what `value` reads. */
export function usePersistedState<T>(key: string, options: PersistOptions<T>, target: SavedStateStore = savedStateStore()): PersistedPart<T> {
  let saving = false;
  const changed = () => target.changed(key, options.version, options.value, options.maxLength);
  const stop = watch(options.value, () => saving && changed(), { deep: true });
  if (getCurrentScope()) {
    onScopeDispose(() => {
      stop();
      if (saving) target.flush();
    });
  }
  return {
    restore(): T | undefined {
      const saved = target.read(key, options.version);
      let restored: T | undefined;
      try {
        restored = saved === undefined ? undefined : options.validate(saved);
      } catch {
        restored = undefined;
      }
      if (!saving) {
        saving = true;
        // What the page shows from now on is saved, e.g. without the parts that no longer fit.
        changed();
      }
      return restored;
    },
    flush: () => target.flush(),
  };
}

/** Reading saved values: each returns undefined for a value that is not of the kind asked for. */
export const savedValue = {
  object(value: unknown): Record<string, unknown> | undefined {
    return isObject(value) ? value : undefined;
  },
  string(value: unknown, maxLength = Infinity): string | undefined {
    return typeof value === 'string' && value.length <= maxLength ? value : undefined;
  },
  number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  },
  integer(value: unknown, min = 0): number | undefined {
    return Number.isInteger(value) && (value as number) >= min ? (value as number) : undefined;
  },
  boolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  },
  oneOf<C extends string>(value: unknown, choices: readonly C[]): C | undefined {
    return typeof value === 'string' && (choices as readonly string[]).includes(value) ? (value as C) : undefined;
  },
  /** Strings only, at most `maxItems` of them, each at most `maxLength` long. */
  strings(value: unknown, maxItems: number, maxLength = Infinity): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((v): v is string => typeof v === 'string' && v.length <= maxLength).slice(0, maxItems);
  },
};

/** Text to keep, or undefined when it is too long to keep whole; a draft cut short would be wrong when restored. */
export function keepText(text: string, maxLength: number): string | undefined {
  return text.length <= maxLength ? text : undefined;
}

/** A short hash of a value, to tell whether what a draft was based on is still the same. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  // FNV-1a, 32 bits, with the length to make collisions of different lengths impossible.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}.${text.length.toString(36)}`;
}
