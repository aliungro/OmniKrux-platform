import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryOut, FoundTool, SourceIn, SourceOut } from "../api/types";
import { BAD_FILTER, NO_METRIC_NAME, validFilter } from "../projects/FilterField";
import { keepableSource, pruneSetupDrafts, readSetupDraft, removeSetupDraft, SETUP_DRAFT_PREFIX, writeSetupDraft } from "./setupDraftStore";
import { blockedBy, canContinue, installComponents, picksFromDiscovery, setupBody, type SetupDraft, type SetupPick } from "./setupModel";

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
  it("picksFromDiscovery uses a reachable Alertmanager", () => {
    const [am] = picksFromDiscovery(discovery(tool("alertmanager", "reachable", { port: "9093" })), []);
    expect(am.use).toBe(true);
    expect(am.label).toBe("Alertmanager");
    expect(am.source).toEqual({
      new: { type: "alertmanager", reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "alertmanager-server", port: "9093", scheme: "http" },
    });
  });

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

  it("installComponents lists what is to install, only for a cluster", () => {
    expect(installComponents(draft({}))).toEqual([]);
    expect(installComponents(draft({ install: { metrics: false, logs: false } }))).toEqual([]);
    expect(installComponents(draft({ install: { metrics: true, logs: true } }))).toEqual(["metrics", "logs"]);
    expect(installComponents(draft({ install: { metrics: false, logs: true } }))).toEqual(["logs"]);
    expect(installComponents(draft({ kind: "docker", install: { metrics: true, logs: true } }))).toEqual([]);
    expect(installComponents(draft({ clusterId: null, install: { metrics: true, logs: false } }))).toEqual([]);
  });

  it("canContinue with something to install and no source in use", () => {
    const logs = { metrics: false, logs: true };
    expect(canContinue(draft({ step: 2, install: logs }))).toBe(true);
    expect(canContinue(draft({ step: 2, kind: "docker", install: logs }))).toBe(false);
    expect(canContinue(draft({ step: 4, name: "", install: logs }))).toBe(false);
    expect(canContinue(draft({ step: 4, name: "Shop", install: logs }))).toBe(true);
    expect(blockedBy(draft({ step: 2 }))).toBe("Pick at least one source, or add one by hand.");
    expect(blockedBy(draft({ step: 2 }), { installOffered: true })).toBe("Pick at least one source, install one, or add one by hand.");
    // Installs aren't part of /setup.
    expect(setupBody(draft({ step: 4, name: "Shop", install: logs }))).toEqual({ name: "Shop", kind: "kubernetes", cluster_id: "c1", sources: [] });
  });
});

describe("setup draft store", () => {
  beforeEach(() => localStorage.clear());
  /** Every secret value below (a stored entry also says `secretsDropped`, which isn't one). */
  const SECRETS = /p-secret|t-secret|k-secret|KEY-secret|h-secret|q-secret|pw-in-url/;
  const secretSource: SourceIn = {
    type: "prometheus", reach: "url", url: "http://user:pw-in-url@prom.example:9090/x?token=q-secret#f", name: "Prom",
    auth: { type: "mtls", username: null, password: "p-secret", token: "t-secret", api_key: "k-secret", client_cert_pem: "CERT", client_key_pem: "KEY-secret" },
    headers: [{ name: "X-A", value: "h-secret" }, { name: "X-B" }], ca_pem: "CA",
  };

  it("keepableSource copies only what holds no secret", () => {
    const { source, dropped } = keepableSource(secretSource);
    expect(dropped).toBe(true);
    expect(source).toEqual({
      type: "prometheus", reach: "url", url: "http://prom.example:9090/x", name: "Prom",
      auth: { type: "mtls", username: null, client_cert_pem: "CERT" }, headers: [{ name: "X-A" }, { name: "X-B" }], ca_pem: "CA",
    });
    expect(JSON.stringify(source)).not.toMatch(SECRETS);
    const plain: SourceIn = { type: "loki", reach: "url", url: "http://loki:3100", auth: { type: "none" }, headers: [{ name: "X-A" }] };
    expect(keepableSource(plain)).toEqual({ source: plain, dropped: false });
  });

  it("a kept draft comes back for its tab and start, its secret picks unticked", () => {
    const d = draft({
      step: 4, name: "Shop", install: { metrics: true, logs: false },
      picks: [
        pick({ key: "hand:2", label: "Prom", detail: secretSource.url as string, source: { new: secretSource } }),
        pick({ key: "existing:s1", source: { existingId: "s1" }, filter: 'a="b"', origin: "user" }),
      ],
    });
    writeSetupDraft("tab-a", "c1", d, true);
    const raw = localStorage.getItem(`${SETUP_DRAFT_PREFIX}tab-a`) ?? "";
    expect(raw).not.toMatch(SECRETS);
    expect(readSetupDraft("tab-a", "")).toBeNull();
    expect(readSetupDraft("tab-b", "c1")).toBeNull();
    const back = readSetupDraft("tab-a", "c1");
    expect(back?.named).toBe(true);
    expect(back?.draft.step).toBe(4);
    expect(back?.draft.install).toEqual({ metrics: true, logs: false });
    const [hand, existing] = back?.draft.picks ?? [];
    expect(hand.use).toBe(false);
    expect(hand.secretsDropped).toBe(true);
    expect(hand.detail).toBe("http://prom.example:9090/x");
    expect(existing).toEqual(d.picks[1]);
  });

  it("a bad or old entry is ignored, and closed tabs' drafts go", () => {
    for (const bad of ["{", "null", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, start: "", named: false, draft: { step: 3, kind: null, clusterId: null, picks: [], name: "" } })]) {
      localStorage.setItem(`${SETUP_DRAFT_PREFIX}t1`, bad);
      expect(readSetupDraft("t1", "")).toBeNull();
    }
    writeSetupDraft("t1", "", draft({ step: 1 }), false);
    writeSetupDraft("t2", "", draft({ step: 1 }), false);
    localStorage.setItem("omnikrux.other", "x");
    pruneSetupDrafts(["t2"]);
    expect(readSetupDraft("t1", "")).toBeNull();
    expect(readSetupDraft("t2", "")).not.toBeNull();
    expect(localStorage.getItem("omnikrux.other")).toBe("x");
    removeSetupDraft("t2");
    expect(readSetupDraft("t2", "")).toBeNull();
  });

  it("storage that throws changes nothing", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    try {
      expect(() => writeSetupDraft("t1", "", draft({}), false)).not.toThrow();
      expect(readSetupDraft("t1", "")).toBeNull();
      expect(() => removeSetupDraft("t1")).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
