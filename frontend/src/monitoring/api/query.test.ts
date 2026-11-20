import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryFailure, runQuery } from "./query";
import type { QueryRequest, QueryResponse } from "./types";

const req: QueryRequest = { source_id: "s1", project_id: "p1", kind: "instant", query: "up" };
const ok: QueryResponse = {
  result_type: "vector", series: [{ labels: { job: "api" }, points: [[1, 1]] }], streams: [], warnings: [], truncated: false,
  source_id: "s1", source_name: "Prom", source_type: "prometheus", project_id: "p1", applied_filter: "", query: "up", took_ms: 3,
};
const answer = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => vi.unstubAllGlobals());

describe("runQuery", () => {
  it("returns the series and maps errors", async () => {
    const fetchMock = answer(ok);
    vi.stubGlobal("fetch", fetchMock);
    expect((await runQuery(req)).series[0].labels).toEqual({ job: "api" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/monitoring/query");
    expect(JSON.parse(init.body)).toMatchObject({ project_id: "p1", query: "up" });

    vi.stubGlobal("fetch", answer({ detail: { code: "not_linked", message: "This source isn't linked to that project." } }, 404));
    const failure = await runQuery(req).catch((e) => e);
    expect(failure).toBeInstanceOf(QueryFailure);
    expect(failure).toMatchObject({ status: 404, code: "not_linked", message: "This source isn't linked to that project." });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const down = await runQuery(req).catch((e) => e);
    expect(down).toMatchObject({ code: "network", message: "OmniKrux didn't answer. Check that it's running, then try again." });
  });

  it("maps a detail that is not {code, message} to bad_request in words", async () => {
    vi.stubGlobal("fetch", answer({ detail: [{ loc: ["body", "query"], msg: "String too long" }] }, 422));
    const list = await runQuery(req).catch((e) => e);
    expect(list).toMatchObject({ status: 422, code: "bad_request" });
    expect(list.message).toContain("String too long");
    expect(list.message).not.toContain("[object");

    vi.stubGlobal("fetch", answer({ detail: "Not allowed here." }, 403));
    expect(await runQuery(req).catch((e) => e)).toMatchObject({ code: "bad_request", message: "Not allowed here." });

    vi.stubGlobal("fetch", answer({ detail: { code: "nonsense", message: "Odd." } }, 500));
    expect(await runQuery(req).catch((e) => e)).toMatchObject({ code: "bad_request", message: "Odd." });
  });

  it("lets an abort through unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    expect(await runQuery(req).catch((e) => e)).toBe(abort);
  });
});
