import { describe, expect, it } from "vitest";
import type { DiscoveryOut, FoundTool, SourceOut } from "../api/types";
import { BAD_FILTER, NO_METRIC_NAME, validFilter } from "../projects/FilterField";
import { canContinue, picksFromDiscovery, setupBody, type SetupDraft, type SetupPick } from "./setupModel";

const T = "2026-01-01T00:00:00Z";

function tool(type: FoundTool["type"], state: FoundTool["state"], over: Partial<FoundTool> = {}): FoundTool {
  return {
    type, state, namespace: state === "missing" ? null : "monitoring", service: state === "missing" ? null : `${type}-server`,
    port: state === "missing" ? null : "9090", scheme: "http", version: state === "reachable" ? "3.1.0" : null,
    message: state === "unreachable" ? "connection refused" : null, existing_source_id: null, detail: null, ...over,
  };
}

const discovery = (...found: FoundTool[]): DiscoveryOut =>
  ({ cluster_id: "c1", cluster_name: "prod-east", state: "ok", message: null, found, checked_at: T });

function saved(id: string, name: string): SourceOut {
  return {
    id, name, type: "loki", reach: "cluster", url: null, cluster_id: "c1", cluster_name: "prod-east", namespace: "monitoring",
    service: "loki-server", port: "9090", scheme: "http", path_prefix: "",
    auth: { type: "none", username: null, header_name: null, has_password: false, has_token: false, has_api_key: false, has_client_key: false, has_client_cert: false },
    headers: [], has_ca: false, created_by_project_id: null, used_by: [], health: { state: "unknown", message: null, version: null, checked_at: null },
    created_at: T, updated_at: T,
  };
}

const pick = (over: Partial<SetupPick>): SetupPick => ({
  key: "k", label: "Prometheus", detail: "", use: true, source: { existingId: "s1" }, filter: "", origin: "none", reason: null, ...over,
});
const draft = (over: Partial<SetupDraft>): SetupDraft => ({ step: 2, kind: "kubernetes", clusterId: "c1", picks: [], name: "", ...over });

describe("setup model", () => {
  it("picksFromDiscovery uses reachable tools and reuses existing sources", () => {
    const picks = picksFromDiscovery(discovery(
      tool("prometheus", "reachable"),
      tool("loki", "unreachable", { existing_source_id: "s9" }),
      tool("grafana", "reachable"),
      tool("loki", "missing"),
    ), [saved("s9", "Loki · prod-east")]);
    expect(picks).toHaveLength(2);
    const [prom, loki] = picks;
    expect(prom.use).toBe(true);
    expect(prom.label).toBe("Prometheus");
    expect(prom.detail).toBe("monitoring/prometheus-server · v3.1.0");
    expect(prom.source).toEqual({
      new: { type: "prometheus", reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "prometheus-server", port: "9090", scheme: "http" },
    });
    expect(prom.filter).toBe("");
    expect(prom.origin).toBe("none");
    expect(loki.use).toBe(false);
    expect(loki.source).toEqual({ existingId: "s9" });
    expect(loki.label).toBe("Loki · prod-east");
    expect(new Set(picks.map((p) => p.key)).size).toBe(2);
  });

  it("setupBody sends only what is in use, new and existing alike", () => {
    const body = setupBody(draft({
      step: 4, name: "  Shop  ",
      picks: [
        pick({ key: "a", source: { existingId: "s1" }, filter: ' cluster="kind" ', origin: "auto" }),
        pick({ key: "b", use: false }),
        pick({ key: "c", source: { new: { type: "loki", reach: "url", url: "http://loki:3100" } }, origin: "user", filter: "" }),
      ],
    }));
    expect(body).toEqual({
      name: "Shop", kind: "kubernetes", cluster_id: "c1",
      sources: [
        { source_id: "s1", filter: 'cluster="kind"', origin: "auto" },
        { source: { type: "loki", reach: "url", url: "http://loki:3100" }, filter: "", origin: "user" },
      ],
    });
    expect(setupBody(draft({ kind: "docker", clusterId: "c1", name: "Box" }))).toEqual({ name: "Box", kind: "docker", sources: [] });
  });

  it("canContinue needs a choice, a source in use, readable filters and a name", () => {
    expect(canContinue(draft({ step: 1, kind: null, clusterId: null }))).toBe(false);
    expect(canContinue(draft({ step: 1, kind: "kubernetes", clusterId: null }))).toBe(false);
    expect(canContinue(draft({ step: 1, kind: "kubernetes", clusterId: "c1" }))).toBe(true);
    expect(canContinue(draft({ step: 1, kind: "servers", clusterId: null }))).toBe(true);
    expect(canContinue(draft({ step: 2, picks: [pick({ use: false })] }))).toBe(false);
    expect(canContinue(draft({ step: 2, picks: [pick({})] }))).toBe(true);
    expect(canContinue(draft({ step: 2, picks: [pick({ filter: "cluster=kind" })] }))).toBe(false);
    expect(canContinue(draft({ step: 2, picks: [pick({}), pick({ key: "x", use: false, filter: "cluster=kind" })] }))).toBe(true);
    expect(canContinue(draft({ step: 4, name: " ", picks: [pick({})] }))).toBe(false);
    expect(canContinue(draft({ step: 4, name: "Shop", picks: [pick({})] }))).toBe(true);
    expect(canContinue(draft({ step: 4, name: "Shop", picks: [pick({ filter: "{" })] }))).toBe(false);
  });

  it("validFilter follows the server's rule and words", () => {
    for (const ok of ["", "  ", "{}", 'cluster="kind"', '{cluster="kind"}', ' a = "x" , b!="y",c=~"z.*" ,d!~"\\"q\\""', 'x="a\\nb\\\\"']) {
      expect(validFilter(ok), ok).toBeNull();
    }
    for (const bad of ["cluster=kind", 'cluster="kind",', 'cluster="kind" job="x"', '1abc="x"', 'a=="x"', 'a="x', 'a="\\t"', "{", 'a~"x"']) {
      expect(validFilter(bad), bad).toBe(BAD_FILTER);
    }
    expect(validFilter('__name__="up"')).toBe(NO_METRIC_NAME);
    expect(BAD_FILTER).toBe('Use label matchers like cluster="prod-east", separated by commas.');
  });
});
