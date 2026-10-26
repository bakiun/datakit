import { describeConnectionError } from '@datakit/adapter-common';

/** An error answer of a REST service; Schema Registry, Connect and ksqlDB send `{error_code, message}`. */
export class RestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: number | null,
  ) {
    super(message);
  }
}

export interface RestRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** A base URL as typed, without the trailing slash. */
export function baseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Talks to one REST service; `service` names it in errors, e.g. `Schema Registry`. */
export class RestClient {
  constructor(
    readonly service: string,
    readonly url: string,
    private readonly timeoutMs: number,
    private readonly contentType = 'application/json',
  ) {}

  /** Sends a request; throws a RestError with the service's message for an error answer. */
  async send(path: string, request: RestRequest = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const headers: Record<string, string> = { Accept: this.contentType, ...request.headers };
    if (request.body !== undefined) headers['Content-Type'] ??= this.contentType;
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: request.method ?? 'GET',
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal,
      });
    } catch (error) {
      throw this.unreachable(error, timeout.aborted);
    }
    if (!response.ok) throw await this.errorOf(response);
    return response;
  }

  /** Sends a request and reads the JSON answer; undefined for an empty one. */
  async json<T>(path: string, request: RestRequest = {}): Promise<T> {
    const response = await this.send(path, request);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private unreachable(error: unknown, timedOut: boolean): Error {
    const e = error as Error;
    if (e.name === 'AbortError' && !timedOut) return e;
    if (timedOut || e.name === 'TimeoutError') return new Error(`${this.service} did not answer within ${this.timeoutMs / 1000} s (${this.url}).`);
    const cause = (e.cause ?? e) as Error;
    return new Error(`${this.service} is not reachable: ${describeConnectionError(cause, this.url).message}`);
  }

  private async errorOf(response: Response): Promise<RestError> {
    const text = await response.text().catch(() => '');
    let message = text.trim() || `${response.status} ${response.statusText}`;
    let code: number | null = null;
    try {
      const body = JSON.parse(text) as { message?: unknown; error_code?: unknown; errorMessage?: unknown };
      const said = body.message ?? body.errorMessage;
      if (typeof said === 'string' && said) message = said;
      if (typeof body.error_code === 'number') code = body.error_code;
    } catch {
      // Not JSON; keep the text.
    }
    return new RestError(`${this.service}: ${message}${code === null ? '' : ` (error ${code})`}`, response.status, code);
  }
}

/** Runs `run` on the items, at most `limit` at a time, and keeps their order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
