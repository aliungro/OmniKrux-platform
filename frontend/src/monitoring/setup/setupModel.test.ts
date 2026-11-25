import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryOut, FoundTool, SourceIn, SourceOut } from "../api/types";
import { BAD_FILTER, NO_METRIC_NAME, validFilter } from "../projects/FilterField";
import type { ImportPreviewOut, PreviewDashboardOut } from "../transfer/api";
import { keepableGrafana, keepableSource, pruneSetupDrafts, readSetupDraft, removeSetupDraft, SETUP_DRAFT_PREFIX, writeSetupDraft } from "./setupDraftStore";
import {
  blockedBy, canContinue, grafanaFromDiscovery, hasImportStep, importCommitBody, installComponents, picksFromDiscovery, setupBody,
  type SetupDraft, type SetupImport, type SetupPick,
} from "./setupModel";

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
    const offered = { installOffered: true };
    expect(canContinue(draft({ step: 2, install: logs }), offered)).toBe(true);
    expect(canContinue(draft({ step: 2, kind: "docker", install: logs }), offered)).toBe(false);
    expect(canContinue(draft({ step: 4, name: "", install: logs }), offered)).toBe(false);
    expect(canContinue(draft({ step: 4, name: "Shop", install: logs }), offered)).toBe(true);
    // Until the tools read says installing is available (loading, failed, unavailable), an install doesn't count.
    expect(canContinue(draft({ step: 2, install: logs }))).toBe(false);
    expect(canContinue(draft({ step: 4, name: "Shop", install: logs }))).toBe(false);
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

  it("only named fields are kept: a field added later never reaches storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      const extra = draft({
        step: 2,
        picks: [{ ...pick({ key: "hand:1", source: { new: { type: "loki", reach: "url", url: "http://loki:3100" } } }), connection: { token: "pick-extra-token" } } as SetupPick],
      });
      const withImport = { ...extra, importFrom: { connection: { url: "http://grafana:3000", token: "draft-extra-token" } } } as unknown as SetupDraft;
      writeSetupDraft("t1", "c1", withImport, false);
      expect(setItem).toHaveBeenCalled();
      for (const [k, v] of setItem.mock.calls) {
        expect(`${k}${v}`).not.toMatch(/extra-token|importFrom|connection/);
      }
      const back = readSetupDraft("t1", "c1");
      expect(Object.keys(back?.draft ?? {}).sort()).toEqual(["clusterId", "kind", "name", "picks", "step"]);
      expect(Object.keys(back?.draft.picks[0] ?? {}).sort()).toEqual(["detail", "filter", "key", "label", "origin", "reason", "source", "use"]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("a bad or old entry is ignored, and closed tabs' drafts go", () => {
    for (const bad of ["{", "null", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, start: "", named: false, draft: { step: 5, kind: null, clusterId: null, picks: [], name: "" } })]) {
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

describe("setup import from Grafana (M6)", () => {
  const GRAFANA = tool("grafana", "reachable", { service: "grafana", port: "80", version: "12.1.0" });
  const dash = (key: string, over: Partial<PreviewDashboardOut> = {}): PreviewDashboardOut => ({
    key, title: key, suggested_title: key, title_taken: false, panels: 1, alerts: 0, skipped: [], problems: [], importable: true, digest: `dg-${key}`, ...over,
  });
  const preview: ImportPreviewOut = {
    format: "grafana_instance", format_label: "Grafana dashboards", target_kinds: ["project"], suggested_target: null, bundle: null,
    sources: [
      { key: "prom", type: "prometheus", type_guessed: false, name: "Prometheus", detail: null, suggestion: null, leave_out: false, reason: "" },
      { key: "logs", type: "loki", type_guessed: false, name: "Loki", detail: null, suggestion: null, leave_out: false, reason: "" },
    ],
    dashboards: [dash("u1", { suggested_title: "Overview" }), dash("u2", { suggested_title: "Overview (2)" }), dash("u3", { importable: false })],
    skipped_total: 0,
  };

  it("grafanaFromDiscovery takes the first reachable Grafana through its cluster", () => {
    expect(grafanaFromDiscovery(discovery(tool("grafana", "unreachable"), GRAFANA))).toEqual({
      name: "Grafana · prod-east", reach: "cluster", cluster_id: "c1", namespace: "monitoring", service: "grafana", port: "80", scheme: "http", auth: { type: "none" },
    });
    expect(grafanaFromDiscovery(discovery(tool("grafana", "unreachable"), tool("prometheus", "reachable")))).toBeNull();
  });

  it("hasImportStep needs this cluster's discovery with a reachable Grafana", () => {
    const d = discovery(GRAFANA);
    expect(hasImportStep(draft({}), d)).toBe(true);
    expect(hasImportStep(draft({}), undefined)).toBe(false);
    expect(hasImportStep(draft({ clusterId: "c2" }), d)).toBe(false);
    expect(hasImportStep(draft({ kind: "docker", clusterId: null }), d)).toBe(false);
    expect(hasImportStep(draft({}), discovery(tool("grafana", "unreachable")))).toBe(false);
  });

  it("importCommitBody sends the preview's titles and digests and the project's first source for every ref", () => {
    const connection = grafanaFromDiscovery(discovery(GRAFANA))!;
    const importFrom: SetupImport = { connection, label: "Grafana", uids: ["u1", "u2", "u3"], preview };
    expect(importCommitBody({ importFrom }, "p9")).toEqual({
      input: { kind: "grafana", connection, uids: ["u1", "u2", "u3"] },
      target: { kind: "project", id: "p9" },
      new_group: null,
      mapping: [{ key: "prom", source_id: null }, { key: "logs", source_id: null }],
      dashboards: [{ key: "u1", title: "Overview", digest: "dg-u1" }, { key: "u2", title: "Overview (2)", digest: "dg-u2" }],
    });
    expect(importCommitBody({ importFrom: { ...importFrom, preview: null } }, "p9")).toBeNull();
    expect(importCommitBody({ importFrom: { ...importFrom, uids: [] } }, "p9")).toBeNull();
    expect(importCommitBody({ importFrom: null }, "p9")).toBeNull();
    expect(importCommitBody({ importFrom: { ...importFrom, preview: { ...preview, dashboards: [dash("u3", { importable: false })] } } }, "p9")).toBeNull();
  });

  it("a kept import holds no secret and no preview, and asks for its sign-in again", () => {
    clearStorage();
    const importFrom: SetupImport = {
      connection: { name: "Main", reach: "url", url: "http://admin:pw-in-url@grafana.example.invalid:3000/g?x=1", auth: { type: "basic", username: "admin", password: "pw-secret", token: "tk-secret" } },
      label: "Main", uids: ["u1", "u2"], preview,
    };
    expect(keepableGrafana(importFrom.connection)).toEqual({
      connection: { name: "Main", reach: "url", url: "http://grafana.example.invalid:3000/g", auth: { type: "basic", username: "admin" } }, dropped: true,
    });
    writeSetupDraft("t1", "c1", draft({ step: 3, importFrom }), false);
    const raw = localStorage.getItem(`${SETUP_DRAFT_PREFIX}t1`) ?? "";
    expect(raw).not.toMatch(/pw-secret|tk-secret|pw-in-url|digest|dg-u1/);
    const back = readSetupDraft("t1", "c1");
    expect(back?.draft.step).toBe(3);
    expect(back?.draft.importFrom).toEqual({
      connection: { name: "Main", reach: "url", url: "http://grafana.example.invalid:3000/g", auth: { type: "basic", username: "admin" } },
      label: "Main", uids: ["u1", "u2"], preview: null, secretsDropped: true,
    });
    // Through its cluster nothing is secret: it comes back ready to load.
    const cluster = grafanaFromDiscovery(discovery(GRAFANA))!;
    writeSetupDraft("t1", "c1", draft({ step: 4, importFrom: { connection: cluster, label: "Grafana", uids: ["u1"], preview } }), false);
    expect(readSetupDraft("t1", "c1")?.draft.importFrom).toEqual({ connection: cluster, label: "Grafana", uids: ["u1"], preview: null });
    // An import that doesn't fit is read as no draft at all.
    localStorage.setItem(`${SETUP_DRAFT_PREFIX}t1`, JSON.stringify({ v: 1, start: "c1", named: false, draft: { ...draft({}), importFrom: { connection: { reach: "ftp" }, label: "x", uids: [] } } }));
    expect(readSetupDraft("t1", "c1")).toBeNull();
  });
});

function clearStorage() {
  localStorage.clear();
}
