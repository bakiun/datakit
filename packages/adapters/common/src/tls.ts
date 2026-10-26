import type { SslSettings } from '@datakit/core';
import { readUserFile } from './files';

export interface TlsFiles {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
}

/** Loads the CA, client certificate and client key named on the SSH / SSL tab. */
export async function loadTlsFiles(ssl: SslSettings): Promise<TlsFiles> {
  const files: TlsFiles = {};
  if (ssl.caFile.trim()) files.ca = await readUserFile(ssl.caFile, 'CA file');
  if (ssl.certFile.trim()) files.cert = await readUserFile(ssl.certFile, 'client certificate');
  if (ssl.keyFile.trim()) files.key = await readUserFile(ssl.keyFile, 'client key');
  return files;
}
