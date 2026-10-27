import { describe, expect, it } from 'vitest';
import { createDataSourceSettings, isSecretName, redactSettings, stripSecrets } from '../src';

describe('stripping secrets from text', () => {
  it('drops the password of a URL and keeps the user', () => {
    expect(stripSecrets('mysql://app:s3cr%40t@db.local:3306/shop')).toBe('mysql://app@db.local:3306/shop');
    expect(stripSecrets('mongodb+srv://u:p4ss@cluster0.example.net/?retryWrites=true')).toBe('mongodb+srv://u@cluster0.example.net/?retryWrites=true');
    expect(stripSecrets('https://key:token-123@registry.example.com')).toBe('https://key@registry.example.com');
    expect(stripSecrets('redis://:only-password@cache:6379/0')).toBe('redis://@cache:6379/0');
  });

  it('empties secret parameters, quoted or not', () => {
    expect(stripSecrets('postgres://u@h/db?sslmode=require&password=hunter2&x=1')).toBe('postgres://u@h/db?sslmode=require&password=&x=1');
    expect(stripSecrets('sasl.password=abc sasl.username=me')).toBe('sasl.password= sasl.username=me');
    expect(stripSecrets('org.apache.kafka.common.security.plain.PlainLoginModule required username="app" password="p\\"w";')).toBe(
      'org.apache.kafka.common.security.plain.PlainLoginModule required username="app" password=;',
    );
    expect(stripSecrets('access_token=eyJhbGci')).toBe('access_token=');
  });

  it('leaves text without secrets alone', () => {
    for (const text of ['localhost', 'mysql://app@db:3306/shop?ssl-mode=REQUIRED', 'SELECT 1', '/Users/me/.ssh/id_ed25519', 'broker-1:9092,broker-2:9092']) {
      expect(stripSecrets(text)).toBe(text);
    }
  });

  it('knows secret names', () => {
    expect(['password', 'sshPassphrase', 'sasl.jaas.config', 'apiKey', 'access_token', 'clientSecret'].every(isSecretName)).toBe(true);
    expect(['connectTimeout', 'charset', 'authSource', 'scanCount'].some(isSecretName)).toBe(false);
  });
});

describe('redacting data source settings', () => {
  it('keeps no secret in any field and leaves the rest as it is', () => {
    const s = createDataSourceSettings('kafka');
    s.kafka.schemaRegistryUrl = 'https://sr-user:sr-pass@registry.example.com';
    s.kafka.connectUrl = 'http://connect:8083?token=connect-token';
    s.properties = [
      { key: 'requestTimeout', value: '30000' },
      { key: 'sasl.jaas.config', value: 'PlainLoginModule required username="a" password="jaas-pass";' },
      { key: 'clientSecret', value: 'oauth-secret' },
    ];
    s.options.initSql = "SET @pass = 1";
    const redacted = redactSettings(s);
    const text = JSON.stringify(redacted);
    for (const secret of ['sr-pass', 'connect-token', 'jaas-pass', 'oauth-secret']) expect(text).not.toContain(secret);
    expect(redacted.kafka.schemaRegistryUrl).toBe('https://sr-user@registry.example.com');
    expect(redacted.properties).toEqual([
      { key: 'requestTimeout', value: '30000' },
      { key: 'sasl.jaas.config', value: '' },
      { key: 'clientSecret', value: '' },
    ]);
    expect(redacted.kafka.bootstrapServers).toBe(s.kafka.bootstrapServers);
    // The input is not changed.
    expect(s.properties[2]!.value).toBe('oauth-secret');
  });
});
