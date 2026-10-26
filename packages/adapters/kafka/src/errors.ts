import { describeConnectionError } from '@datakit/adapter-common';
import { AuthenticationError, GenericError, ProtocolError, TimeoutError } from '@platformatic/kafka';

/** What the driver's errors may carry: aggregates nest in `errors`, wrappers in `cause`. */
interface DriverError extends Error {
  code?: unknown;
  errors?: unknown[];
  cause?: unknown;
  apiId?: string;
  serverErrorMessage?: string | null;
  response?: unknown;
}

/** Every error in the tree under `error`, aggregate entries before causes, as the driver searches them. */
function flatten(error: unknown, found: DriverError[] = [], seen = new Set<unknown>()): DriverError[] {
  if (!error || typeof error !== 'object' || seen.has(error)) return found;
  seen.add(error);
  const e = error as DriverError;
  found.push(e);
  if (Array.isArray(e.errors)) for (const nested of e.errors) flatten(nested, found, seen);
  if (e.cause) flatten(e.cause, found, seen);
  return found;
}

const isDriverError = (e: DriverError) => GenericError.isGenericError(e);

/** Whether the broker answered with this error, e.g. `TOPIC_ALREADY_EXISTS`. */
export function hasKafkaError(error: unknown, id: string): boolean {
  return flatten(error).some((e) => e instanceof ProtocolError && e.apiId === id);
}

/** The response a failed API call still carries; a request fails as a whole when one of its entries failed. */
export function responseOf<T>(error: unknown): T | undefined {
  return flatten(error).find((e) => e.response !== undefined)?.response as T | undefined;
}

/** `host:port` of the broker a connection error names, e.g. `Connection to broker-1:9092 failed.` */
function brokerOf(errors: DriverError[]): string | null {
  for (const e of errors) {
    const match = /^Connection to (.+?) (?:failed|timed out)\.$/.exec(e.message);
    if (match) return match[1]!;
  }
  return null;
}

/** The broker's own text for the protocol errors in the tree, without repeats. */
function protocolMessages(errors: DriverError[]): string[] {
  const texts = errors.filter((e) => e instanceof ProtocolError).map((e) => e.serverErrorMessage?.trim() || e.message);
  return [...new Set(texts)];
}

/**
 * A short message for an error of the driver: the socket error of a connection, the SASL failure, or the
 * broker's own text. `target` names the endpoint when the error does not say which broker failed.
 */
export function describeKafkaError(error: unknown, target: string): Error {
  const errors = flatten(error);
  if (!errors.length) return new Error(String(error));
  const where = brokerOf(errors) ?? target;

  const auth = errors.find((e) => e instanceof AuthenticationError);
  if (auth) {
    const detail = protocolMessages(flatten(auth.cause));
    return new Error(`${auth.message.replace(/\.$/, '')} (${where})${detail.length ? `: ${detail.join('; ')}` : '.'}`);
  }
  // Errors of Node itself: sockets, DNS, TLS. They have a code such as ECONNREFUSED.
  const native = errors.find((e) => !isDriverError(e) && typeof e.code === 'string');
  if (native) {
    const described = describeConnectionError(native, where);
    return described === native ? new Error(`${native.message} (${where}).`) : described;
  }
  if (errors.some((e) => e instanceof TimeoutError && /^Connection/.test(e.message))) return new Error(`Connection timed out (${where}).`);
  const protocol = protocolMessages(errors);
  if (protocol.length) return new Error(protocol.join('; '));
  // The innermost message is the most specific one, e.g. `Unknown topic orders.`
  const leaf = [...errors].reverse().find((e) => !(Array.isArray(e.errors) && e.errors.length) && !e.cause) ?? errors[0]!;
  return new Error(leaf.message);
}

/** The broker's error for a code an answer carried, e.g. 3 for UNKNOWN_TOPIC_OR_PARTITION. */
export function protocolError(code: number, message: string | null = null): Error {
  try {
    return new ProtocolError(code, message);
  } catch {
    // A code newer than the driver knows.
    return new Error(message || `The broker answered with error code ${code}.`);
  }
}

/** Runs a driver call and turns its error into a readable one. */
export async function readable<T>(target: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw describeKafkaError(error, target);
  }
}
