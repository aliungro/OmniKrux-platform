/**
 * Plain words for a failed request: the server's own `detail` verbatim, or, when nothing answered
 * (fetch rejects with a TypeError), what to check. `tryAgain` names the way to try again.
 */
export function failure(err: unknown, tryAgain = "try again"): string {
  if (err instanceof TypeError) return `Can't reach the console's server. Check that it's running, then ${tryAgain}.`;
  return err instanceof Error ? err.message : String(err);
}

/** A request the server answered with an error: `status` tells a conflict (409) from an expired plan (404). */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

async function fail(res: Response): Promise<never> {
  let detail: string | undefined;
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") detail = body.detail;
  } catch {
    // body was not JSON
  }
  throw new HttpError(res.status, detail ?? `${res.status} ${res.statusText}`.trim());
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

export async function postEmpty(path: string): Promise<void> {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) return fail(res);
}

/**
 * POSTs JSON (or nothing) and reads JSON back; the server's `detail` becomes the error's words.
 * `opts` passes a `signal` (to drop an answer nobody waits for) and a request `cache` mode.
 */
export async function postJson<T>(path: string, body?: unknown, opts: Pick<RequestInit, "signal" | "cache"> = {}): Promise<T> {
  const init: RequestInit = { method: "POST", ...opts };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}
