import { cloneSettings, type DataSourceSettings } from './dataSource';

/**
 * Removing secrets from text that is kept in plain text, e.g. the form a webview keeps to come back after a reload.
 * Passwords themselves live in SecretStorage; these catch the ones that were typed or pasted into other fields.
 */

/** Names of fields and parameters that hold a secret: passwords, passphrases, tokens, keys, JAAS configs. */
const SECRET_NAME = /pass(?:word|phrase|wd)?|pwd|secret|token|credential|jaas|api[-_.]?key|private[-_.]?key/i;

/** The password of a URL's user info: `scheme://user:password@host` keeps `scheme://user@host`. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*):[^\s/?#@]*@/gi;
/** A secret given as a parameter, in a URL query or as `key=value` text, e.g. `?password=x` or `sasl.password=x`. */
const PARAM_SECRET = /((?:^|[?&;\s,])[\w.-]*(?:pass(?:word|phrase|wd)?|pwd|secret|token|api[-_.]?key)[\w.-]*\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^&;\s,#]*)/gi;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** The text without the passwords and tokens it holds; everything else stays as it is. */
export function stripSecrets(text: string): string {
  return text.replace(URL_PASSWORD, '$1@').replace(PARAM_SECRET, '$1');
}

/**
 * The settings without a secret anywhere: URLs lose their passwords, `password=…` parameters their values, and a
 * driver property named like a secret keeps its name but not its value.
 */
export function redactSettings(settings: DataSourceSettings): DataSourceSettings {
  const copy = cloneSettings(settings);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return stripSecrets(value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  const redacted = walk(copy) as DataSourceSettings;
  redacted.properties = redacted.properties.map((p) => (isSecretName(p.key) ? { key: p.key, value: '' } : p));
  return redacted;
}
