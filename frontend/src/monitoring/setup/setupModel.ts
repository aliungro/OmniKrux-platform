// The setup page's draft and the rules around it. The draft is kept in this browser per Monitoring
// tab (`setupDraftStore.ts`) so a setup left mid-way comes back: the step, what is monitored, the
// picks, their filters, the name, the install toggles and the Grafana dashboards to copy. Secrets
// never are: a new source's password, token, API key, client key and header values, a Grafana
// connection's password and token, and an address carrying a sign-in, are dropped before anything
// is written (the pick comes back unticked, the Grafana asks for its sign-in again), and the forms
// being typed are never kept. Nothing here goes in a query or mutation cache.
import type { DiscoveryOut, FilterOrigin, FoundTool, ProjectKind, SetupIn, SetupSourceIn, SourceIn, SourceOut, SourceType } from "../api/types";
import { readyViewTitles } from "../dashboards/readyViews";
import type { Component, ToolType } from "../install/api";
import { validFilter } from "../projects/FilterField";
import type { GrafanaIn, ImportCommitIn, ImportPreviewOut, PreviewDashboardOut } from "../transfer/api";

/** Step 3 (import) is shown only when discovery found a Grafana it can reach (`hasImportStep`). */
export type SetupStep = 1 | 2 | 3 | 4;

/**
 * The Grafana dashboards to copy into the new project: the connection (the cluster's Grafana, or
 * its address with a sign-in), the dashboards chosen, and the preview made for exactly those
 * (null until it is made; never kept in this browser).
 */
export type SetupImport = {
  connection: GrafanaIn;
  label: string;
  uids: string[];
  preview: ImportPreviewOut | null;
  /** Restored without the connection's secret: it asks for its sign-in again instead of loading. */
  secretsDropped?: boolean;
  /** The dashboards were chosen (none included): a restored list doesn't choose them all again. */
  chosen?: boolean;
};

export type SetupPick = {
  /** `found:<type>:<namespace>/<service>`, `existing:<id>` or `hand:<n>`. */
  key: string;
  label: string;
  detail: string;
  use: boolean;
  source: { existingId: string } | { new: SourceIn };
  filter: string;
  origin: FilterOrigin;
  reason: string | null;
  /** The cluster a filter suggestion was asked for; it goes with the pick, so a new pick is asked again. */
  suggestedFor?: string;
  /** A secret of this new source wasn't kept in browser storage: restored, it isn't used. */
  secretsDropped?: boolean;
};

/** What to install into the cluster after the project is created (reviewed first). */
export type SetupInstall = { metrics: boolean; logs: boolean };
export const NO_INSTALL: SetupInstall = { metrics: false, logs: false };

export type SetupDraft = {
  step: SetupStep;
  kind: ProjectKind | null;
  clusterId: string | null;
  picks: SetupPick[];
  name: string;
  /** Left out: nothing to install. */
  install?: SetupInstall;
  /** Left out or null: nothing to import. */
  importFrom?: SetupImport | null;
};

export const TOOL_NAMES: Record<FoundTool["type"], string> = { prometheus: "Prometheus", loki: "Loki", grafana: "Grafana", alertmanager: "Alertmanager" };

export const foundKey = (t: FoundTool): string => `found:${t.type}:${t.namespace ?? ""}/${t.service ?? ""}`;

/** `<namespace>/<service> · v<version>`, or as much of it as is known. */
export function foundDetail(t: FoundTool): string {
  const where = `${t.namespace ?? ""}/${t.service ?? ""}`;
  return t.version ? `${where} · v${t.version.replace(/^v/, "")}` : where;
}

/**
 * The Prometheus, Loki and Alertmanager found in a cluster as picks: a reachable one is in use, one that can't
 * be reached is not, and one that is already a source is reused rather than added again.
 */
export function picksFromDiscovery(d: DiscoveryOut, existing: SourceOut[]): SetupPick[] {
  const names = new Map(existing.map((x) => [x.id, x.name]));
  return d.found
    .filter((t) => t.type !== "grafana" && t.state !== "missing")
    .map((t) => {
      const type = t.type as SourceType;
      const known = t.existing_source_id;
      const source: SetupPick["source"] = known
        ? { existingId: known }
        : { new: { type, reach: "cluster", cluster_id: d.cluster_id, namespace: t.namespace, service: t.service, port: t.port, scheme: t.scheme } };
      return {
        key: foundKey(t),
        label: (known && names.get(known)) || TOOL_NAMES[type],
        detail: foundDetail(t),
        use: t.state === "reachable",
        source,
        filter: "",
        origin: "none",
        reason: null,
      };
    });
}

/** A tool that answered at the address a generated file gave it. */
export type AnsweredTool = { type: ToolType; url: string; version: string | null };

export function hostOfUrl(url: string): string {
  try { return new URL(url.trim()).hostname; } catch { return url; }
}

/** `Prometheus · docker-host.example`: the name of a source made from an answered tool. */
export const answeredLabel = (t: AnsweredTool): string => `${TOOL_NAMES[t.type]} · ${hostOfUrl(t.url)}`;

/** The source an answered tool becomes: its address, no sign-in (the generated tools have none). */
export const answeredSource = (t: AnsweredTool): SourceIn => ({ name: answeredLabel(t), type: t.type, reach: "url", url: t.url });

/** Key of a pick made from an answered tool: one per tool type, so writing the file again replaces it. */
export const answeredKey = (type: ToolType): string => `generated:${type}`;

export const isAnswered = (p: Pick<SetupPick, "key">): boolean => p.key.startsWith("generated:");

/** One pick per answered tool, in use. */
export const picksFromAnswered = (tools: AnsweredTool[]): SetupPick[] =>
  tools.map((t) => ({
    key: answeredKey(t.type), label: answeredLabel(t), detail: t.url, use: true, source: { new: answeredSource(t) }, filter: "", origin: "none", reason: null,
  }));

export const inUse = (draft: Pick<SetupDraft, "picks">): SetupPick[] => draft.picks.filter((p) => p.use);

/** The missing tool a component installs, as discovery names it. */
export const INSTALLS: Record<Component, "prometheus" | "loki"> = { metrics: "prometheus", logs: "loki" };

/** What is to be installed: only for a Kubernetes cluster, metrics first. Not part of `/setup`. */
export function installComponents(draft: Pick<SetupDraft, "kind" | "clusterId" | "install">): Component[] {
  const want = draft.install;
  if (draft.kind !== "kubernetes" || draft.clusterId === null || !want) return [];
  return (["metrics", "logs"] as const).filter((c) => want[c]);
}

/** What the server is sent: the project, its new sources and every link, all at once. */
export function setupBody(draft: SetupDraft): SetupIn {
  const sources: SetupSourceIn[] = inUse(draft).map((p) => ({
    ...("existingId" in p.source ? { source_id: p.source.existingId } : { source: p.source.new }),
    filter: p.filter.trim(),
    origin: p.origin,
  }));
  return {
    name: draft.name.trim(),
    kind: draft.kind ?? "custom",
    ...(draft.kind === "kubernetes" && draft.clusterId ? { cluster_id: draft.clusterId } : {}),
    sources,
  };
}

export const NOTHING_PICKED = "Pick at least one source, or add one by hand.";
export const NOTHING_PICKED_OR_INSTALLED = "Pick at least one source, install one, or add one by hand.";

/**
 * Why the page can't move on yet, in words, or `null` when it can. A source in use or a component
 * to install is enough, but a component counts only once OmniKrux has said it can install there
 * (`installOffered`: the tools read answered available), which the words then say too.
 */
export function blockedBy(draft: SetupDraft, opts: { installOffered?: boolean } = {}): string | null {
  if (draft.step === 1) {
    if (draft.kind === null) return "Pick what this project monitors.";
    if (draft.kind === "kubernetes" && draft.clusterId === null) return "Pick a cluster.";
    return null;
  }
  const used = inUse(draft);
  const installs = opts.installOffered ? installComponents(draft).length : 0;
  if (used.length === 0 && installs === 0) return opts.installOffered ? NOTHING_PICKED_OR_INSTALLED : NOTHING_PICKED;
  if (used.some((p) => validFilter(p.filter) !== null)) return "Fix the filter that can't be read, or clear it.";
  if (draft.step === 4 && draft.name.trim() === "") return "Give the project a name.";
  return null;
}

export const canContinue = (draft: SetupDraft, opts: { installOffered?: boolean } = {}): boolean => blockedBy(draft, opts) === null;

// --- Import from the Grafana found in the cluster --------------------------------------------

/** The first Grafana discovery could reach, as a connection through its cluster (no sign-in). */
export function grafanaFromDiscovery(d: DiscoveryOut): GrafanaIn | null {
  const g = d.found.find((t) => t.type === "grafana" && t.state === "reachable" && t.namespace && t.service && t.port);
  if (!g) return null;
  return {
    name: `Grafana · ${d.cluster_name}`, reach: "cluster", cluster_id: d.cluster_id,
    namespace: g.namespace, service: g.service, port: g.port, scheme: g.scheme, auth: { type: "none" },
  };
}

/** Whether the page shows step 3: a Kubernetes cluster whose discovery found a reachable Grafana. */
export function hasImportStep(draft: Pick<SetupDraft, "kind" | "clusterId">, discovery: DiscoveryOut | null | undefined): boolean {
  return draft.kind === "kubernetes" && draft.clusterId !== null && discovery != null
    && discovery.cluster_id === draft.clusterId && grafanaFromDiscovery(discovery) !== null;
}

/** The dashboards of the preview that will be copied. */
export const importable = (p: ImportPreviewOut): PreviewDashboardOut[] => p.dashboards.filter((d) => d.importable);

/** What won't be copied, over the dashboards that will be. */
export const importSkipped = (p: ImportPreviewOut): number => importable(p).reduce((n, d) => n + d.skipped.length, 0);

/**
 * The import into the new project, or null when there is nothing to import (no dashboards chosen,
 * no preview yet, or none of them converts). Each dashboard keeps its preview's suggested title
 * (unique within the batch) and digest; every Grafana data source reads the project's first source
 * of its type (`source_id: null`), which covers a type being installed: its panels pick up the
 * installed source once it is linked.
 */
export function importCommitBody(draft: Pick<SetupDraft, "importFrom">, projectId: string): ImportCommitIn | null {
  const imp = draft.importFrom;
  if (!imp || imp.uids.length === 0 || !imp.preview) return null;
  const dashboards = importable(imp.preview).map((d) => ({ key: d.key, title: d.suggested_title, digest: d.digest }));
  if (dashboards.length === 0) return null;
  return {
    input: { kind: "grafana", connection: imp.connection, uids: [...imp.uids] },
    target: { kind: "project", id: projectId },
    new_group: null,
    mapping: imp.preview.sources.map((r) => ({ key: r.key, source_id: null })),
    dashboards,
  };
}

/** The type of a pick's source: found ones carry it in their key, new ones in the source, existing ones by id. */
export function pickType(p: SetupPick, types: ReadonlyMap<string, SourceType>): SourceType | undefined {
  const found = /^found:(prometheus|loki|alertmanager):/.exec(p.key);
  if (found) return found[1] as SourceType;
  return "new" in p.source ? p.source.new.type : types.get(p.source.existingId);
}

/** Which ready-made views the sources in use (and tools to install) bring, by title. */
export function readyFor(
  draft: Pick<SetupDraft, "kind" | "picks" | "install">, types: ReadonlyMap<string, SourceType>, installs: Component[],
): string[] {
  const used = inUse(draft).map((p) => pickType(p, types));
  return readyViewTitles(draft.kind ?? "custom", {
    prometheus: used.includes("prometheus") || installs.includes("metrics"),
    loki: used.includes("loki") || installs.includes("logs"),
  });
}
