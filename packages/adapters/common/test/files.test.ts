import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, loadTlsFiles, readUserFile } from '../src';

describe('expandHome', () => {
  it('expands a leading tilde only', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome(' ~/.ssh/id_ed25519 ')).toBe(join(homedir(), '.ssh/id_ed25519'));
    expect(expandHome('/etc/~x')).toBe('/etc/~x');
  });
});

describe('readUserFile', () => {
  it('names the file and its purpose when it is missing', async () => {
    await expect(readUserFile('/nonexistent/ca.pem', 'CA file')).rejects.toThrow(
      'Could not read CA file “/nonexistent/ca.pem”: file not found.',
    );
  });

  it('loads only the TLS files that are set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'datakit-'));
    await writeFile(join(dir, 'ca.pem'), 'CA');
    const files = await loadTlsFiles({ enabled: true, mode: 'verify-ca', caFile: join(dir, 'ca.pem'), certFile: '', keyFile: '' });
    expect(files.ca?.toString()).toBe('CA');
    expect(files.cert).toBeUndefined();
  });
});
