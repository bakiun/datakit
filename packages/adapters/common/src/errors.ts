/** Turns socket-level errors of a driver into short messages; server errors keep their own text. */
export function describeConnectionError(error: unknown, target: string): Error {
  const e = error as NodeJS.ErrnoException & { fatal?: boolean };
  switch (e.code) {
    case 'ECONNREFUSED':
      return new Error(`Connection refused (${target}).`);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new Error(`Host not found (${target}).`);
    case 'ETIMEDOUT':
      return new Error(`Connection timed out (${target}).`);
    case 'ECONNRESET':
      return new Error(`Connection reset by the server (${target}).`);
    case 'ENOENT':
      return new Error(`Socket not found (${target}).`);
    case 'EACCES':
      return new Error(`Permission denied (${target}).`);
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}
