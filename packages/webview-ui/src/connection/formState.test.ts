import { createDataSourceSettings, parseConnectionUrl, type SecretKey } from '@datakit/core';
import { describe, expect, it } from 'vitest';
import { formToSave, readSavedForm } from './formState';

const SECRETS = ['db-pass-1', 'ssh-pass-2', 'key-phrase-3', 'url-pass-4', 'prop-pass-5', 'registry-pass-6', 'sasl-token-7', 'jaas-pass-8'];

describe('the saved data source form', () => {
  it('holds no password, passphrase or token', () => {
    // What the user typed into the password fields lives beside the settings and is never handed to formToSave.
    const typed: Record<SecretKey, string> = { password: 'db-pass-1', sshPassword: 'ssh-pass-2', sshPassphrase: 'key-phrase-3' };
    const pasted = parseConnectionUrl('mysql://app:url-pass-4@db.example.com:3306/shop?connectTimeout=5000', createDataSourceSettings('mysql'));
    if (!pasted.ok) throw new Error(pasted.error);
    expect(pasted.password).toBe('url-pass-4');
    const settings = pasted.settings;
    settings.ssh = { ...settings.ssh, enabled: true, host: 'bastion', user: 'ops', auth: 'password' };
    settings.properties.push({ key: 'password', value: 'prop-pass-5' });
    settings.comment = 'see https://ops:url-pass-4@wiki.example.com';

    const kafka = createDataSourceSettings('kafka');
    kafka.kafka.schemaRegistryUrl = 'https://sr:registry-pass-6@registry.example.com';
    kafka.kafka.ksqlDbUrl = 'https://ksql.example.com?token=sasl-token-7';
    kafka.properties.push({ key: 'sasl.jaas.config', value: 'PlainLoginModule required username="a" password="jaas-pass-8";' });

    for (const s of [settings, kafka]) {
      const saved = JSON.stringify(formToSave({ mode: 'edit', dataSourceId: 'ds-1', base: 'abc', settings: s, section: 'ssh' }));
      for (const secret of [...SECRETS, ...Object.values(typed)]) expect(saved).not.toContain(secret);
    }

    const restored = readSavedForm(JSON.parse(JSON.stringify(formToSave({ mode: 'edit', dataSourceId: 'ds-1', base: 'abc', settings, section: 'ssh' }))));
    expect(restored?.settings.user).toBe('app');
    expect(restored?.settings.host).toBe('db.example.com');
    expect(restored?.settings.ssh.host).toBe('bastion');
    expect(restored?.settings.properties.find((p) => p.key === 'password')).toEqual({ key: 'password', value: '' });
    expect(restored?.settings.comment).toBe('see https://ops@wiki.example.com');
    expect(restored?.section).toBe('ssh');
  });

  it('fills what is missing or of the wrong type with the defaults', () => {
    const restored = readSavedForm({
      mode: 'new',
      dataSourceId: null,
      settings: { engine: 'redis', host: 'cache', port: 6379, ssh: { host: 'jump', port: 22 }, properties: [{ key: 'x', value: 1 }, { key: 'scanCount', value: '200' }] },
      section: 'nope',
    });
    const defaults = createDataSourceSettings('redis');
    expect(restored?.settings.host).toBe('cache');
    expect(restored?.settings.port).toBe(defaults.port);
    expect(restored?.settings.ssh).toEqual({ ...defaults.ssh, host: 'jump' });
    expect(restored?.settings.properties).toEqual([{ key: 'scanCount', value: '200' }]);
    expect(restored?.section).toBe('general');
  });

  it('refuses what is not a form', () => {
    expect(readSavedForm(undefined)).toBeUndefined();
    expect(readSavedForm({ mode: 'new', settings: { engine: 'oracle' } })).toBeUndefined();
    expect(readSavedForm({ mode: 'other', settings: { engine: 'mysql' } })).toBeUndefined();
  });
});
