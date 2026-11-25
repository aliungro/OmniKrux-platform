import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, HttpError, patchJson, postJson, putJson } from "./http";

afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, status: number, statusText = "") =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } })));

async function rejection(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected the request to fail");
}

describe("http errors", () => {
  it("a string detail is the error's words", async () => {
    vi.stubGlobal("fetch", answer({ detail: "Unknown cluster" }, 404, "Not Found"));
    const err = await rejection(getJson("/api/x"));
    expect([err.status, err.message]).toEqual([404, "Unknown cluster"]);
  });

  it("FastAPI's list of validation errors becomes plain words, not the status line", async () => {
    vi.stubGlobal(
      "fetch",
      answer(
        {
          detail: [
            { type: "missing", loc: ["body", "key"], msg: "Field required", input: {} },
            { type: "extra_forbidden", loc: ["body", "extra"], msg: "Extra inputs are not permitted", input: 1 },
            { type: "value_error", loc: [], msg: "Value error, bad" },
          ],
        },
        422,
        "Unprocessable Entity",
      ),
    );
    const err = await rejection(postJson("/api/x", {}));
    expect(err.status).toBe(422);
    expect(err.message).toBe(
      "The console's server refused the request: key: Field required; extra: Extra inputs are not permitted; Value error, bad.",
    );
  });

  it("the console's own sentences name the field and end with one period", async () => {
    vi.stubGlobal(
      "fetch",
      answer(
        {
          detail: [
            { type: "string_pattern_mismatch", loc: ["body", "tenant_id"], msg: "A field has an invalid format. Check the value and try again." },
            { type: "missing", loc: ["body", "regions", 1], msg: "A required field is missing." },
          ],
        },
        422,
      ),
    );
    expect((await rejection(postJson("/api/x", {}))).message).toBe(
      "The console's server refused the request: tenant_id: A field has an invalid format. Check the value and try again. regions.1: A required field is missing.",
    );
  });

  it("an answer without a usable detail falls back to the status", async () => {
    vi.stubGlobal("fetch", answer({ detail: [{ nope: true }] }, 500, "Internal Server Error"));
    expect((await rejection(getJson("/api/x"))).message).toBe("500 Internal Server Error");
  });
});

describe("patchJson and putJson", () => {
  it("send JSON with their own verbs and read JSON back", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await patchJson("/x", { a: 1 })).toEqual({ ok: true });
    expect(await putJson("/y", { b: 2 })).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]).toEqual(["/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"a":1}' }]);
    expect(fetchMock.mock.calls[1]).toEqual(["/y", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"b":2}' }]);
  });

  it("turn an error answer into an HttpError with the server's words", async () => {
    vi.stubGlobal("fetch", answer({ detail: "Taken." }, 409));
    expect(await rejection(patchJson("/x", {}))).toMatchObject({ status: 409, message: "Taken." });
    expect(await rejection(putJson("/x", {}))).toMatchObject({ status: 409, message: "Taken." });
  });
});
