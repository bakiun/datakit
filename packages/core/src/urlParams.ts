import type { ConnectionString } from 'connection-string';
import type { DriverProperty } from './dataSource';
import type { EngineDescriptor } from './engines';

/** URL parameters by lower-cased name; a repeated parameter keeps its last value. `take` removes what it reads. */
export function urlParams(url: ConnectionString) {
  const params = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(url.params ?? {})) {
    params.set(key.toLowerCase(), { key, value: String(Array.isArray(value) ? value.at(-1) : value) });
  }
  return {
    take(...names: string[]): string | undefined {
      for (const name of names) {
        const param = params.get(name.toLowerCase());
        if (param) {
          params.delete(name.toLowerCase());
          return param.value;
        }
      }
      return undefined;
    },
    /** The parameters left: driver options become properties, the rest is reported as ignored. */
    rest(engine: EngineDescriptor): { properties: DriverProperty[]; ignored: string[] } {
      const optionNames = Object.keys(engine.driverOptions);
      const properties: DriverProperty[] = [];
      const ignored: string[] = [];
      for (const { key: name, value } of params.values()) {
        const option = optionNames.find((o) => o.toLowerCase() === name.toLowerCase());
        if (option) properties.push({ key: option, value });
        else ignored.push(name);
      }
      return { properties, ignored };
    },
  };
}
