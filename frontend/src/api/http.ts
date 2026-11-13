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

/**
 * FastAPI's request-validation answer (a 422 whose `detail` is a list of `{loc, msg}`) in words:
 * "key: Field required; extra: Extra inputs are not permitted". Undefined when nothing is usable.
 */
function validationWords(detail: unknown): string | undefined {
  if (!Array.isArray(detail)) return undefined;
  const parts = detail.flatMap((d: unknown) => {
    if (typeof d !== "object" || d === null || typeof (d as { msg?: unknown }).msg !== "string") return [];
    const { loc, msg } = d as { loc?: unknown; msg: string };
    // "body" and "query" say where the field was, which isn't the reader's concern.
    const field = Array.isArray(loc) ? loc.filter((p, i) => !(i === 0 && (p === "body" || p === "query" || p === "path"))).join(".") : "";
    return [field ? `${field}: ${msg}` : msg];
  });
  return parts.length > 0 ? `The console's server refused the request: ${parts.join("; ")}.` : undefined;
}

async function fail(res: Response): Promise<never> {
  let detail: string | undefined;
  try {
    const body = await res.json();
    if (body && typeof body.detail === "string") detail = body.detail;
    else if (body) detail = validationWords(body.detail);
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

export async function postEmpty(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, jsonPost(body));
  if (!res.ok) return fail(res);
}

function jsonPost(body?: unknown, opts: Pick<RequestInit, "signal" | "cache"> = {}): RequestInit {
  const init: RequestInit = { method: "POST", ...opts };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return init;
}

/** POSTs JSON (or nothing) and reads JSON back; the server's `detail` becomes the error's words. */
export async function postJson<T>(path: string, body?: unknown, opts: Pick<RequestInit, "signal" | "cache"> = {}): Promise<T> {
  const res = await fetch(path, jsonPost(body, opts));
  if (!res.ok) return fail(res);
  return (await res.json()) as T;
}

/** DELETEs and expects an empty answer (204). */
export async function deleteEmpty(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) return fail(res);
}
