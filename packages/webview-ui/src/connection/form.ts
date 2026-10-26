import { cloneSettings, type DataSourceSettings, type FieldErrors, type FileField, type SecretKey } from '@datakit/core';
import { inject, type ComputedRef, type InjectionKey, type Ref } from 'vue';

/** Copies settings into the form; nested objects are updated in place because the tabs hold on to them. */
export function assignSettings(target: DataSourceSettings, source: DataSourceSettings): void {
  const { ssh, ssl, kafka, mongo, options, ...rest } = cloneSettings(source);
  Object.assign(target, rest);
  Object.assign(target.ssh, ssh);
  Object.assign(target.ssl, ssl);
  Object.assign(target.kafka, kafka);
  Object.assign(target.mongo, mongo);
  Object.assign(target.options, options);
}

/** State of the data source form, shared by its tabs. */
export interface DataSourceForm {
  settings: DataSourceSettings;
  /** What the user typed into password fields. */
  secrets: Record<SecretKey, string>;
  /** Password fields the user changed; untouched ones keep the stored secret. */
  touched: Record<SecretKey, boolean>;
  storedSecrets: Ref<Record<SecretKey, boolean>>;
  errors: ComputedRef<FieldErrors>;
  /** Field errors are shown once the user tried to save. */
  error(field: string): string | undefined;
  browse(field: FileField): void;
}

export const formKey: InjectionKey<DataSourceForm> = Symbol('dataSourceForm');

export function useForm(): DataSourceForm {
  const form = inject(formKey);
  if (!form) throw new Error('useForm() must be used inside the data source editor.');
  return form;
}
