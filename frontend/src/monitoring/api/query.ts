import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { QueryErrorCode, QueryRequest, QueryResponse } from "./types";

export const NETWORK_MESSAGE = "OmniKrux didn't answer. Check that it's running, then try again.";

const CODES: readonly QueryErrorCode[] = [
  "not_found", "not_linked", "bad_request", "bad_query", "unreachable", "timeout", "unauthorized", "too_large", "tool_error",
];

/** A query that didn't produce an answer; `message` is plain words for the reader. */
export class QueryFailure extends Error {
  readonly status: number;
  readonly code: QueryErrorCode | "network";

  constructor(status: number, code: QueryErrorCode | "network", message: string) {
    super(message);
    this.name = "QueryFailure";
    this.status = status;
    this.code = code;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** A FastAPI validation list (`[{loc, msg}]`) as one readable sentence. */
function validationWords(detail: unknown[]): string | undefined {
  const parts = detail.flatMap((d) => (isObject(d) && typeof d.msg === "string" ? [d.msg] : []));
  return parts.length ? `The query was refused: ${parts.join("; ")}.` : undefined;
}

async function failureOf(res: Response): Promise<QueryFailure> {
  let detail: unknown;
  try {
    detail = ((await res.json()) as { detail?: unknown } | null)?.detail;
  } catch {
    // not JSON
  }
  if (isObject(detail) && typeof detail.message === "string") {
    const code = CODES.find((c) => c === detail.code) ?? "bad_request";
    return new QueryFailure(res.status, code, detail.message);
  }
  const words =
    typeof detail === "string" && detail ? detail
    : Array.isArray(detail) ? validationWords(detail)
    : undefined;
  return new QueryFailure(res.status, "bad_request", words ?? `The query was refused (${`${res.status} ${res.statusText}`.trim()}).`);
}

/** Runs one query on the server. Rejects with `QueryFailure`; an abort passes through unchanged. */
export async function runQuery(req: QueryRequest, signal?: AbortSignal): Promise<QueryResponse> {
  let res: Response;
  try {
    res = await fetch("/api/monitoring/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new QueryFailure(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await failureOf(res);
  return (await res.json()) as QueryResponse;
}

/** A query kept in the cache; `null` waits. Never retried: a failure's words are the answer. */
export function useMonitoringQuery(req: QueryRequest | null, opts: { refetchInterval?: number } = {}): UseQueryResult<QueryResponse, QueryFailure> {
  return useQuery<QueryResponse, QueryFailure>({
    queryKey: ["monitoring", "query", req],
    queryFn: ({ signal }) => runQuery(req as QueryRequest, signal),
    enabled: req !== null,
    retry: false,
    refetchInterval: opts.refetchInterval,
  });
}
