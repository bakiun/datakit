import {
  createDataSourceSettings,
  ENGINES,
  redactSettings,
  type DataSourceSettings,
  type EditorState,
  type FormSection,
} from '@datakit/core';
import { savedValue } from '../composables/usePersistedState';

/**
 * The data source form as the page keeps it to come back after a reload: the fields, the open tab and which data
 * source it is. VS Code keeps this as plain text, so the typed passwords never go in, and secrets typed or pasted into
 * other fields (a URL with a password, a `password` driver property) are removed.
 */
export interface SavedForm {
  mode: EditorState['mode'];
  dataSourceId: string | null;
  /** The settings the form was loaded with, as a fingerprint; a changed data source does not take an old draft. */
  base: string | null;
  settings: DataSourceSettings;
  section: FormSection;
}

const SECTIONS: readonly FormSection[] = ['general', 'ssh', 'options', 'advanced'];
const GROUPS = ['ssh', 'ssl', 'kafka', 'mongo', 'options'] as const;

/** What the form keeps; it is given no passwords, and the settings are redacted. */
export function formToSave(form: SavedForm): SavedForm {
  return { mode: form.mode, dataSourceId: form.dataSourceId, base: form.base, settings: redactSettings(form.settings), section: form.section };
}

/** Takes each saved value whose type matches the default's; anything else keeps the default. */
function merge<T extends object>(defaults: T, saved: unknown): T {
  const source = savedValue.object(saved);
  if (!source) return defaults;
  const result = { ...defaults } as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    if (key in source && typeof source[key] === typeof value && (typeof value !== 'object' || value === null)) result[key] = source[key];
  }
  return result as T;
}

/** The saved form, filled up with the defaults of its engine; undefined when it is not a form. */
export function readSavedForm(saved: unknown): SavedForm | undefined {
  const o = savedValue.object(saved);
  const s = savedValue.object(o?.settings);
  const engine = ENGINES.find((e) => e.id === s?.engine)?.id;
  const mode = savedValue.oneOf(o?.mode, ['new', 'edit'] as const);
  if (!o || !s || !engine || !mode) return undefined;
  const defaults = createDataSourceSettings(engine);
  const settings = merge(defaults, s);
  for (const group of GROUPS) (settings as unknown as Record<string, unknown>)[group] = merge(defaults[group], s[group]);
  if (Array.isArray(s.properties)) {
    settings.properties = s.properties
      .map((p) => savedValue.object(p))
      .filter((p): p is Record<string, unknown> => !!p && typeof p.key === 'string' && typeof p.value === 'string')
      .map((p) => ({ key: p.key as string, value: p.value as string }));
  }
  return {
    mode,
    dataSourceId: o.dataSourceId === null ? null : (savedValue.string(o.dataSourceId) ?? null),
    base: savedValue.string(o.base) ?? null,
    settings,
    section: savedValue.oneOf(o.section, SECTIONS) ?? 'general',
  };
}
