import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolves a leading `~` to the home directory, as users type it in path fields. */
export function expandHome(path: string): string {
  const p = path.trim();
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/** Reads a key or certificate file; the error names the file and what it was for. */
export async function readUserFile(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(expandHome(path));
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : (error as Error).message;
    throw new Error(`Could not read ${label} “${path.trim()}”: ${reason}.`);
  }
}
