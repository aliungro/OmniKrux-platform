import { describe, expect, it } from "vitest";
import { canRetryAfterClose, refusalWords, wsUrl } from "./ws";

describe("wsUrl", () => {
  it("points at this page's own host, ws for http", () => {
    const url = wsUrl("/api/logs", new URLSearchParams({ cluster: "c 1", pod: "a/b" }));
    expect(url).toBe(`ws://${window.location.host}/api/logs?cluster=c+1&pod=a%2Fb`);
  });
});

describe("close codes", () => {
  it("says each refusal in plain words, for the request it refused", () => {
    expect(refusalWords(1008, "shell")).toBe("The console turned down this shell request. Open the shell again from the pod.");
    expect(refusalWords(1008, "log")).toBe("The console turned down this log request. Open the logs again from the pod.");
    expect(refusalWords(4403, "log")).toBe(
      "The console refused the connection from this page. Open the console from its own address.",
    );
    expect(refusalWords(4404, "shell")).toBe(
      "Unknown cluster. It may have been removed from the kubeconfig; pick it again from the list.",
    );
    expect(refusalWords(1006, "shell")).toBeNull();
  });

  it("trying again can't help after 1008 or 4403", () => {
    expect([1008, 4403, 4404, 1011, 1006].map(canRetryAfterClose)).toEqual([false, false, true, true, true]);
  });
});
