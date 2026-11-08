// frontend/src/features/palette/commands.test.ts
import { describe, expect, it, vi } from "vitest";
import type { KindInfo, ResourceRow } from "../../api/types";
import { CERTIFICATES, DEPLOYMENTS, EVENTS, HELM, NODES, PODS, SERVICES, STATEFULSETS } from "../../test/kinds";
import { rowActions } from "../actions/tools";
import { buildCommands, rankCommands, type CommandContext } from "./commands";

const CONFIGMAPS: KindInfo = { ...SERVICES, key: "configmaps", kind: "ConfigMap", plural: "configmaps", label: "Config map", plural_label: "config maps", short_names: ["cm"] };
const KUSTOMIZATIONS: KindInfo = {
  ...CERTIFICATES, key: "kustomizations.kustomize.toolkit.fluxcd.io", group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization",
  plural: "kustomizations", label: "Kustomization", plural_label: "kustomizations", short_names: ["ks"],
};
const SERVED: KindInfo[] = [
  { ...PODS, short_names: ["po"] },
  { ...DEPLOYMENTS, short_names: ["deploy"] },
  STATEFULSETS,
  { ...SERVICES, short_names: ["svc"] },
  NODES,
  EVENTS,
  HELM,
  CONFIGMAPS,
  CERTIFICATES,
  KUSTOMIZATIONS,
];

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  kinds: SERVED,
  onKind: vi.fn(),
  selected: null,
  onRowAction: vi.fn(),
  onAudit: vi.fn(),
  ...over,
});

const row = (over: Partial<ResourceRow>): ResourceRow => ({
  uid: "u1", cluster_id: "c1", kind: "Deployment", namespace: "demo", name: "web", created_at: null, labels: {},
  columns: { ready: "2/3", resource_version: "1" }, ...over,
});

const VERBS = ["get", "list", "watch", "update", "patch", "delete"];
const ALL = { change: true, logs: true, shell: true, workloadLogs: true };

describe("buildCommands", () => {
  it("every served kind is a command that jumps to it", () => {
    const c = ctx();
    const cmds = buildCommands(c);
    const kinds = cmds.filter((x) => x.group === "Kinds").map((x) => x.label);
    expect(kinds).toEqual(["Pods", "Deployments", "StatefulSets", "Services", "Nodes", "Events", "Helm releases", "Config maps"]);
    cmds.find((x) => x.label === "Deployments")!.run();
    expect(c.onKind).toHaveBeenCalledWith("deployments.apps");
  });

  it("crd kinds appear in the palette", () => {
    const cmds = buildCommands(ctx());
    expect(cmds.filter((x) => x.group === "Custom resources").map((x) => [x.label, x.hint])).toEqual([
      ["Certificates", "certificates.cert-manager.io"],
    ]);
    expect(cmds.filter((x) => x.group === "Flux").map((x) => [x.label, x.hint])).toEqual([
      ["Kustomizations", "kustomizations.kustomize.toolkit.fluxcd.io"],
    ]);
    expect(rankCommands("ks", cmds)[0].label).toBe("Kustomizations");
    expect(rankCommands("cert", cmds)[0].label).toBe("Certificates");
  });

  it("row actions appear for the selected row", () => {
    const web = row({});
    const kind = { ...DEPLOYMENTS, verbs: VERBS };
    const c = ctx({ selected: { row: web, kind, clusterName: "kind-dev", actions: rowActions(kind.key, kind.verbs, web, ALL) } });
    const actions = buildCommands(c).filter((x) => x.group === "Actions");
    expect(actions.map((x) => x.label)).toEqual([
      "Details of web", "YAML of web", "Logs of web's pods", "Edit web…", "Scale web…", "Restart web…", "Roll back web…", "Delete web…",
    ]);
    expect(actions.find((x) => x.label === "Scale web…")!.keys).toEqual(["s"]);
    expect(actions.find((x) => x.label === "Delete web…")!.keys).toEqual(["Ctrl D"]);
    actions.find((x) => x.label === "Scale web…")!.run();
    expect(c.onRowAction).toHaveBeenCalledWith("scale");

    const pod = row({ kind: "Pod", name: "api-1" });
    const pods = { ...PODS, verbs: VERBS };
    const p = buildCommands(ctx({ selected: { row: pod, kind: pods, clusterName: "kind-dev", actions: rowActions("pods", VERBS, pod, ALL) } }));
    expect(p.filter((x) => x.group === "Actions").map((x) => x.label)).toEqual([
      "Details of api-1", "YAML of api-1", "Logs of api-1", "Previous logs of api-1", "Shell in api-1", "Edit api-1…", "Port-forward api-1…", "Delete api-1…",
    ]);
    // A Secret's row: its keys (Ruling R38), never a reveal straight from the palette.
    const secret = row({ kind: "Secret", name: "db" });
    const secrets = { ...SERVICES, key: "secrets", verbs: VERBS };
    const sc = buildCommands(ctx({ selected: { row: secret, kind: secrets, clusterName: "kind-dev", actions: rowActions("secrets", VERBS, secret, ALL) } }));
    expect(sc.filter((x) => x.group === "Actions").map((x) => x.label)).toEqual(["Details of db", "YAML of db", "Keys of db", "Delete db…"]);
    // Nothing selected: no actions.
    expect(buildCommands(ctx()).some((x) => x.group === "Actions")).toBe(false);
  });

  it("views: the audit log always, port-forwards while one exists", () => {
    const onForwards = vi.fn();
    expect(buildCommands(ctx()).filter((x) => x.group === "Views").map((x) => x.label)).toEqual(["Audit log"]);
    const c = ctx({ onForwards });
    const views = buildCommands(c).filter((x) => x.group === "Views");
    expect(views.map((x) => x.label)).toEqual(["Audit log", "Port-forwards"]);
    views[1].run();
    expect(onForwards).toHaveBeenCalled();
  });
});

describe("rankCommands", () => {
  const cmds = buildCommands(ctx({ onForwards: () => {} }));

  it("short names from discovery match (cm, svc, po)", () => {
    expect(rankCommands("cm", cmds)[0].label).toBe("Config maps");
    expect(rankCommands("svc", cmds)[0].label).toBe("Services");
    // An exact short name beats a label that merely starts with it ("Port-forwards").
    const po = rankCommands("po", cmds).map((x) => x.label);
    expect(po[0]).toBe("Pods");
    expect(po).toContain("Port-forwards");
    expect(rankCommands("deploy", cmds)[0].label).toBe("Deployments");
    expect(rankCommands("DEPLOY", cmds)[0].label).toBe("Deployments");
  });

  it("prefix before subsequence, nothing that doesn't match", () => {
    // "Nodes" by prefix, "Config maps" by subsequence (c…n…f…m in order).
    expect(rankCommands("nodes", cmds).map((x) => x.label)).toEqual(["Nodes"]);
    expect(rankCommands("cnfm", cmds).map((x) => x.label)).toEqual(["Config maps"]);
    expect(rankCommands("nod", cmds)[0].label).toBe("Nodes");
    expect(rankCommands("dpl", cmds).map((x) => x.label)).toEqual(["Deployments"]);
    expect(rankCommands("zzz", cmds)).toEqual([]);
  });

  it("an empty query keeps the order; at most 50", () => {
    expect(rankCommands("", cmds)).toEqual(cmds);
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `k${i}`, label: `Kind ${i}`, group: "Kinds" as const, keywords: [], run: () => {} }));
    expect(rankCommands("", many)).toHaveLength(50);
    expect(rankCommands("kind", many)).toHaveLength(50);
  });
});
