import type { DataSourceSettings, SecretKey, SecretPatch } from '../dataSource';
import type { FieldErrors } from '../validation';

/** Messages between the data source editor webview and the extension. */

export type FileField = 'ssh.privateKeyPath' | 'ssl.caFile' | 'ssl.certFile' | 'ssl.keyFile';

export interface EditorState {
  mode: 'new' | 'edit';
  /** Set in edit mode. */
  id: string | null;
  settings: DataSourceSettings;
  /** Which secrets are already stored, so the form can show them as hidden. */
  storedSecrets: Record<SecretKey, boolean>;
  /** Names of the other data sources, for the uniqueness check. */
  otherNames: string[];
}

export type EditorHostMessage =
  | { type: 'init'; state: EditorState }
  | { type: 'testResult'; ok: boolean; message: string }
  /** Sent after Apply; the form continues in edit mode. */
  | { type: 'saved'; state: EditorState }
  | { type: 'saveFailed'; message: string; errors?: FieldErrors }
  | { type: 'fileSelected'; field: FileField; path: string };

export type EditorWebviewMessage =
  | { type: 'ready' }
  | { type: 'test'; settings: DataSourceSettings; secrets: SecretPatch }
  /** `close` is false for Apply. A new data source is connected after it is saved. */
  | { type: 'save'; settings: DataSourceSettings; secrets: SecretPatch; close: boolean }
  | { type: 'cancel' }
  | { type: 'browse'; field: FileField; current: string };
