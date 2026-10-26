import type { DriverProperty } from './dataSource';

export type PropertyValue = string | number | boolean;

/** Driver properties are typed as text; `true`/`false` and plain numbers are passed on as such. */
export function coercePropertyValue(value: string): PropertyValue {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return value;
}

export function propertiesToObject(properties: readonly DriverProperty[]): Record<string, PropertyValue> {
  const result: Record<string, PropertyValue> = {};
  for (const p of properties) {
    const key = p.key.trim();
    if (key) result[key] = coercePropertyValue(p.value);
  }
  return result;
}
