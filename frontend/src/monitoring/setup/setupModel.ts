// The setup page's draft and the rules around it. The draft is kept in this browser per Monitoring
// tab (`setupDraftStore.ts`) so a setup left mid-way comes back: the step, what is monitored, the
// picks, their filters, the name and the install toggles. Secrets never are: a new source's
// password, token, API key, client key and header values, and an address carrying a sign-in, are
// dropped before anything is written (the pick comes back unticked), and the "add by hand" form
// being typed is never kept. Nothing here goes in a query or mutation cache.
import type { DiscoveryOut, FilterOrigin, FoundTool, ProjectKind, SetupIn, SetupSourceIn, SourceIn, SourceOut, SourceType } from "../api/types";
import type { Component } from "../install/api";
import { validFilter } from "../projects/FilterField";

/** Step 3 (import) comes in a later update, so the page skips it. */
export type SetupStep = 1 | 2 | 4;

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
 * to install is enough; `installOffered` (a cluster where OmniKrux can install) says so in the words.
 */
export function blockedBy(draft: SetupDraft, opts: { installOffered?: boolean } = {}): string | null {
  if (draft.step === 1) {
    if (draft.kind === null) return "Pick what this project monitors.";
    if (draft.kind === "kubernetes" && draft.clusterId === null) return "Pick a cluster.";
    return null;
  }
  const used = inUse(draft);
  if (used.length === 0 && installComponents(draft).length === 0) return opts.installOffered ? NOTHING_PICKED_OR_INSTALLED : NOTHING_PICKED;
  if (used.some((p) => validFilter(p.filter) !== null)) return "Fix the filter that can't be read, or clear it.";
  if (draft.step === 4 && draft.name.trim() === "") return "Give the project a name.";
  return null;
}

export const canContinue = (draft: SetupDraft): boolean => blockedBy(draft) === null;
