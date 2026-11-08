import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, HttpError, postJson } from "./http";

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

  it("an answer without a usable detail falls back to the status", async () => {
    vi.stubGlobal("fetch", answer({ detail: [{ nope: true }] }, 500, "Internal Server Error"));
    expect((await rejection(getJson("/api/x"))).message).toBe("500 Internal Server Error");
  });
});
