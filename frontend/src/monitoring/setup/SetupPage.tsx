import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import type { Cluster } from "../../api/types";
import { useClusters } from "../../api/useClusters";
import { setupProject, suggestFilter } from "../api/client";
import { invalidateMonitoring, useDiscovery, useSources } from "../api/hooks";
import type { FoundTool, ProjectKind, SourceIn, SourceOut, SuggestIn } from "../api/types";
import { installKeys, installTools, type Component } from "../install/api";
import { useInstallReviews } from "../install/useInstallReviews";
import type { MonitoringPageProps } from "../MonitoringApp";
import { FilterField } from "../projects/FilterField";
import { DOT } from "../sidebar/Sidebar";
import { SourceForm } from "../sources/SourceForm";
import { autoTypeName, sourceTypeLabel, whereLabel } from "../sources/sourceLabels";
import { readSetupDraft, removeSetupDraft, SECRET_NOT_KEPT, writeSetupDraft } from "./setupDraftStore";
import {
  blockedBy, foundDetail, foundKey, installComponents, INSTALLS, inUse, NO_INSTALL, picksFromDiscovery, setupBody, TOOL_NAMES,
  type SetupDraft, type SetupPick, type SetupStep,
} from "./setupModel";
import s from "./SetupPage.module.css";

const EMPTY: SourceOut[] = [];
const GENERATES = "OmniKrux connects to tools that already run there, or writes the files to install them for you to run.";
/** How long the draft waits for typing to settle before it is kept in this browser. */
const KEEP_AFTER_MS = 300;

/** What each component installs: the line under a pressed row, and the review's summary line. */
const INSTALL_WORDS: Record<Component, { line: string; summary: string }> = {
  metrics: {
    line: "Installs Prometheus, Alertmanager, node-exporter and kube-state-metrics with Helm after you create the project. You review it first.",
    summary: "Install: Prometheus, Alertmanager, node-exporter and kube-state-metrics into the cluster",
  },
  logs: {
    line: "Installs Loki and Grafana Alloy (collects Pod logs) with Helm after you create the project. You review it first.",
    summary: "Install: Loki and Grafana Alloy into the cluster",
  },
};
const COMPONENT_OF: Partial<Record<FoundTool["type"], Component>> = { [INSTALLS.metrics]: "metrics", [INSTALLS.logs]: "logs" };

/** Whether OmniKrux can install into the cluster: `null` while that isn't known yet. */
type Offer = { available: true } | { available: false; why: string } | null;

const KINDS: { kind: ProjectKind; title: string; what: string; sub: string }[] = [
  { kind: "kubernetes", title: "A Kubernetes cluster", what: "Kubernetes cluster", sub: "OmniKrux looks inside it for Prometheus, Loki and Grafana." },
  { kind: "docker", title: "A Docker host", what: "Docker host", sub: "Tools that run on one Docker host." },
  { kind: "servers", title: "Servers", what: "Servers", sub: "Tools that watch machines you run." },
  { kind: "custom", title: "Something of your own", what: "Something of your own", sub: "Any Prometheus-compatible or Loki source you can reach." },
];
const kindInfo = (kind: ProjectKind) => KINDS.find((k) => k.kind === kind) ?? KINDS[3];

const STEPS: { n: 1 | 2 | 3 | 4; title: string }[] = [
  { n: 1, title: "What to monitor" }, { n: 2, title: "Sources" }, { n: 3, title: "Import" }, { n: 4, title: "Name and review" },
];

const isHand = (p: SetupPick) => p.key.startsWith("hand:");
const sourcesInUse = (n: number) => `${n} ${n === 1 ? "source" : "sources"} in use`;
const inUseAndInstalls = (n: number, m: number) => (m > 0 ? `${sourcesInUse(n)} · ${m} to install` : sourcesInUse(n));
/** Where the keyboard goes once the install review over a new project closes: its name. */
const projectHeading = () => document.getElementById("monitoring-project-title");

function hostOf(url: string | null | undefined): string {
  try { return new URL((url ?? "").trim()).hostname; } catch { return ""; }
}

/** Whether the page may take the keyboard as it appears: only when nothing else has it. */
function keyboardIsFree(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active.tagName === "MAIN") return true;
  return active.closest("[data-monitoring-page]") !== null;
}

/**
 * Found picks replace the old ones; what the user changed on a pick that is still there is kept. A
 * tool that is no longer missing isn't installed.
 */
function mergeFound(draft: SetupDraft, fresh: SetupPick[], missing: Set<FoundTool["type"]>): SetupDraft {
  const old = new Map(draft.picks.map((p) => [p.key, p]));
  const found = fresh.map((p) => {
    const was = old.get(p.key);
    return was ? { ...p, use: was.use, filter: was.filter, origin: was.origin, reason: was.reason, suggestedFor: was.suggestedFor } : p;
  });
  const want = draft.install ?? NO_INSTALL;
  const install = { metrics: want.metrics && missing.has(INSTALLS.metrics), logs: want.logs && missing.has(INSTALLS.logs) };
  return { ...draft, picks: [...found, ...draft.picks.filter((p) => !p.key.startsWith("found:"))], install };
}

/** Another kind or cluster: what was found or chosen goes; sources added by hand stay, their suggestions asked again. */
function retarget(draft: SetupDraft, kind: ProjectKind, clusterId: string | null): SetupDraft {
  if (draft.kind === kind && draft.clusterId === clusterId) return draft;
  const picks = draft.picks.filter(isHand).map((p): SetupPick => ({
    ...p, suggestedFor: undefined, ...(p.origin === "user" ? {} : { filter: "", origin: "none" as const, reason: null }),
  }));
  return { ...draft, kind, clusterId, picks, install: NO_INSTALL };
}

function Chip({ tone, children }: { tone: "ok" | "bad" | "warn" | "plain" | "focus"; children: ReactNode }) {
  return <span className={s.chip} data-tone={tone}>{children}</span>;
}

function Badge({ type }: { type: FoundTool["type"] }) {
  return <span className={s.badge} data-type={type} aria-hidden="true">{TOOL_NAMES[type][0]}</span>;
}

/** A pick's on/off switch and, while it is in use, its filter. */
function PickControls({ pick, onChange }: { pick: SetupPick; onChange(patch: Partial<SetupPick>): void }) {
  return (
    <>
      <label className={s.use}>
        <input type="checkbox" className={s.switch} checked={pick.use} onChange={(e) => onChange({ use: e.target.checked })} />
        Use
      </label>
      {pick.use && (
        <div className={s.filter}>
          <FilterField value={pick.filter} origin={pick.origin} reason={pick.reason} forName={pick.label}
            onChange={(filter, origin) => onChange({ filter, origin })} />
        </div>
      )}
    </>
  );
}

/** A missing tool's install: the toggle, or why OmniKrux can't install here. */
function InstallToggle({ name, component, offer, pressed, onToggle }: {
  name: string; component: Component; offer: Offer; pressed: boolean; onToggle(): void;
}) {
  if (offer === null) return null;
  if (!offer.available) return <p className={s.later}>Installing isn&apos;t available here: {offer.why}</p>;
  return (
    <>
      <div className={s.installAct}>
        <button type="button" className={s.install} aria-pressed={pressed} onClick={onToggle}>Install {name}…</button>
      </div>
      {pressed && <p className={s.installLine}>{INSTALL_WORDS[component].line}</p>}
    </>
  );
}

function FoundRow({ tool, pick, existing, offer, installing, onChange, onInstall, onOpenTools }: {
  tool: FoundTool; pick: SetupPick | undefined; existing: SourceOut | undefined; offer: Offer; installing: boolean;
  onChange(patch: Partial<SetupPick>): void; onInstall(): void; onOpenTools(e: MouseEvent<HTMLButtonElement>): void;
}) {
  const name = TOOL_NAMES[tool.type];
  const missing = tool.state === "missing";
  const component = missing ? COMPONENT_OF[tool.type] : undefined;
  const pressed = component !== undefined && installing;
  const chip = pressed ? <Chip tone="focus">To install</Chip>
    : missing ? <Chip tone="warn">Missing</Chip>
    : tool.type === "grafana" ? <Chip tone="plain">Found</Chip>
    : tool.state === "reachable" ? <Chip tone="ok">Reachable</Chip>
    : <Chip tone="bad">Can&apos;t be reached</Chip>;
  const ours = existing?.installed_by_omnikrux === true;
  return (
    <div role="group" aria-label={name} className={s.row} data-muted={(missing && !pressed) || tool.type === "grafana" ? "" : undefined}
      data-install={pressed ? "" : undefined}>
      <Badge type={tool.type} />
      <div className={s.what}>
        <span className={s.toolName}>{name}</span>
        <span className={s.detail}>{missing ? "Not found in this cluster" : foundDetail(tool)}</span>
        {existing && <span className={s.known}>Already a source: {existing.name}</span>}
      </div>
      <div className={s.state}>
        {ours && <Chip tone="plain">Installed by OmniKrux</Chip>}
        {chip}
        {ours && <button type="button" className={s.link} onClick={onOpenTools}>Monitoring tools</button>}
        {tool.state === "unreachable" && tool.message && <span className={s.why}>{tool.message}</span>}
      </div>
      {component !== undefined && <InstallToggle name={name} component={component} offer={offer} pressed={pressed} onToggle={onInstall} />}
      {!missing && tool.type === "grafana" && <p className={s.later}>Importing its dashboards comes in a later update.</p>}
      {pick && <PickControls pick={pick} onChange={onChange} />}
    </div>
  );
}

function HandRow({ pick, onChange, onRemove, onEnterAgain }: {
  pick: SetupPick; onChange(patch: Partial<SetupPick>): void; onRemove(): void; onEnterAgain(): void;
}) {
  const type = "new" in pick.source ? pick.source.new.type : "prometheus";
  // Restored without its secret: it can't be used as it is; entering it again replaces it.
  if (!pick.use && pick.secretsDropped) {
    return (
      <div role="group" aria-label={pick.label} className={s.row} data-muted="">
        <Badge type={type} />
        <div className={s.what}>
          <span className={s.toolName}>{pick.label}</span>
          <span className={s.detail}>{pick.detail}</span>
        </div>
        <div className={s.state}>
          <Chip tone="warn">Not in use</Chip>
          <button type="button" className={s.quiet} onClick={onRemove}>Remove</button>
        </div>
        <p className={s.later}>{SECRET_NOT_KEPT}</p>
        <div className={s.installAct}>
          <button type="button" className={s.secondary} onClick={onEnterAgain}>Enter it again</button>
        </div>
      </div>
    );
  }
  return (
    <div role="group" aria-label={pick.label} className={s.row}>
      <Badge type={type} />
      <div className={s.what}>
        <span className={s.toolName}>{pick.label}</span>
        <span className={s.detail}>{pick.detail}</span>
      </div>
      <div className={s.state}>
        <Chip tone="plain">Added by hand</Chip>
        <button type="button" className={s.quiet} onClick={onRemove}>Remove</button>
      </div>
      <div className={s.filter}>
        <FilterField value={pick.filter} origin={pick.origin} reason={pick.reason} forName={pick.label}
          onChange={(filter, origin) => onChange({ filter, origin })} />
      </div>
    </div>
  );
}

interface StepProps {
  draft: SetupDraft;
  setDraft(update: (d: SetupDraft) => SetupDraft): void;
  heading: RefObject<HTMLHeadingElement | null>;
}

function KindStep({ draft, setDraft, heading, clusters, onOpenSettings }: StepProps & { clusters: ReturnType<typeof useClusters>; onOpenSettings(): void }) {
  const ids = useId();
  const list = clusters.data;
  return (
    <>
      <h2 id={`${ids}-h`} ref={heading} tabIndex={-1} className={s.stepTitle}>What to monitor</h2>
      <p className={s.lead}>A project shows the data of one thing you run. Pick what it is.</p>
      <div role="radiogroup" aria-labelledby={`${ids}-h`} className={s.kinds}>
        {KINDS.map((k) => (
          <label key={k.kind} className={s.kind} data-kind={k.kind}>
            <input type="radio" name={`${ids}-kind`} className={s.radio} checked={draft.kind === k.kind}
              onChange={() => setDraft((d) => retarget(d, k.kind, k.kind === "kubernetes" ? d.clusterId : null))} />
            <span className={s.kindText}>
              <span className={s.kindTitle}>{k.title}</span>
              <span className={s.kindSub}>{k.sub}</span>
            </span>
          </label>
        ))}
      </div>

      {draft.kind === "kubernetes" && (
        <section className={s.clusters} aria-label="Clusters">
          {clusters.isPending && <p className={s.note} role="status">Loading clusters…</p>}
          {clusters.isError && !list && (
            <div className={s.note} role="alert">
              <p>{failure(clusters.error, "try again")}</p>
              <button type="button" className={s.secondary} onClick={() => void clusters.refetch()}>Try again</button>
            </div>
          )}
          {list && list.length === 0 && (
            <div className={s.note}>
              <p>No Kubernetes clusters are connected yet. Add one in Settings, or pick something else.</p>
              <button type="button" className={s.secondary} onClick={onOpenSettings}>Open Settings</button>
            </div>
          )}
          {list && list.length > 0 && (
            <div role="radiogroup" aria-label="Cluster" className={s.clusterList}>
              {list.map((c: Cluster) => (
                <label key={c.id} className={s.cluster}>
                  <input type="radio" name={`${ids}-cluster`} className={s.radio} checked={draft.clusterId === c.id}
                    onChange={() => setDraft((d) => retarget(d, "kubernetes", c.id))} />
                  <i className={s.dot} style={{ background: c.provider in DOT ? DOT[c.provider] : DOT.custom }} aria-hidden="true" />
                  <span className={s.clusterName}>{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </section>
      )}
      {(draft.kind === "docker" || draft.kind === "servers") && <p className={s.note}>{GENERATES}</p>}
    </>
  );
}

function SourcesStep({ draft, setDraft, heading, clusterName, discovery, existing, onAddByHand, handOpen, addButton, form, offer, onOpenTools }: StepProps & {
  clusterName: string; discovery: ReturnType<typeof useDiscovery>; existing: ReturnType<typeof useSources>; handOpen: boolean;
  onAddByHand(): void; addButton: RefObject<HTMLButtonElement | null>; form: ReactNode; offer: Offer;
  onOpenTools(e: MouseEvent<HTMLButtonElement>): void;
}) {
  const cluster = draft.kind === "kubernetes" && draft.clusterId !== null;
  const edit = (key: string) => (patch: Partial<SetupPick>) =>
    setDraft((d) => ({ ...d, picks: d.picks.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
  const remove = (key: string) => {
    setDraft((d) => ({ ...d, picks: d.picks.filter((p) => p.key !== key) }));
    // While the add-by-hand form is open its button isn't there: the step's heading takes the keyboard.
    (addButton.current ?? heading.current)?.focus();
  };
  const enterAgain = (key: string) => {
    setDraft((d) => ({ ...d, picks: d.picks.filter((p) => p.key !== key) }));
    onAddByHand();
  };
  const toggleInstall = (c: Component) => setDraft((d) => {
    const now = d.install ?? NO_INSTALL;
    return { ...d, install: { ...now, [c]: !now[c] } };
  });
  const byKey = new Map(draft.picks.map((p) => [p.key, p]));
  const known = new Map((existing.data ?? EMPTY).map((x) => [x.id, x]));
  const want = draft.install ?? NO_INSTALL;
  const hand = draft.picks.filter(isHand);
  const d = discovery.data;
  const toggleExisting = (x: SourceOut, on: boolean) => setDraft((cur) => ({
    ...cur,
    picks: on
      ? [...cur.picks, { key: `existing:${x.id}`, label: x.name, detail: whereLabel(x), use: true, source: { existingId: x.id }, filter: "", origin: "none", reason: null }]
      : cur.picks.filter((p) => p.key !== `existing:${x.id}`),
  }));

  return (
    <>
      {cluster ? (
        <>
          <h2 ref={heading} tabIndex={-1} className={s.stepTitle}>What we found in {clusterName}</h2>
          <p className={s.lead}>
            {offer?.available
              ? "OmniKrux looked inside the cluster. Use what's there, install what's missing, or add a source by hand."
              : "OmniKrux looked inside the cluster. Use what's there, or add a source by hand."}
          </p>
          <div className={s.looking}>
            <span role="status">{discovery.isFetching ? `Looking inside ${clusterName}…` : ""}</span>
            {/* aria-disabled, not disabled: a button that disables itself would drop the keyboard onto <body>. */}
            <button type="button" className={s.quiet} aria-disabled={discovery.isFetching || undefined}
              onClick={() => { if (!discovery.isFetching) void discovery.refetch(); }}>Look again</button>
          </div>
          {discovery.isError && !d && <p className={s.problem} role="alert">{failure(discovery.error, "look again")}</p>}
          {d?.state === "error" && <p className={s.problem} role="alert">{d.message}</p>}
          {d && d.state === "ok" && d.found.length === 0 && <p className={s.note}>Nothing was found in this cluster. Add a source by hand.</p>}
          {d && d.found.length > 0 && (
            <div className={s.rows}>
              {d.found.map((t) => {
                const key = foundKey(t);
                const component = t.state === "missing" ? COMPONENT_OF[t.type] : undefined;
                return (
                  <FoundRow key={key} tool={t} pick={byKey.get(key)} offer={offer}
                    installing={component !== undefined && want[component]}
                    existing={t.existing_source_id ? known.get(t.existing_source_id) : undefined} onChange={edit(key)}
                    onInstall={() => { if (component) toggleInstall(component); }} onOpenTools={onOpenTools} />
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <h2 ref={heading} tabIndex={-1} className={s.stepTitle}>Sources</h2>
          <p className={s.lead}>Add the tools this project reads from.</p>
          <fieldset className={s.existing}>
            <legend>Use an existing source</legend>
            {existing.isPending && <p className={s.note} role="status">Loading sources…</p>}
            {existing.isError && !existing.data && <p className={s.problem} role="alert">{failure(existing.error, "try again")}</p>}
            {existing.data?.length === 0 && <p className={s.empty}>No sources yet. Add one by hand below.</p>}
            {existing.data && existing.data.length > 0 && (
              <div className={s.rows}>
                {existing.data.map((x) => {
                  const pick = byKey.get(`existing:${x.id}`);
                  return (
                    <div key={x.id} className={s.row}>
                      <Badge type={x.type} />
                      <label className={s.what}>
                        <span className={s.toolName}>
                          <input type="checkbox" className={s.switch} checked={pick !== undefined} onChange={(e) => toggleExisting(x, e.target.checked)} />
                          {x.name}
                        </span>
                        <span className={s.detail}>{sourceTypeLabel(x.type)} · {whereLabel(x)}</span>
                      </label>
                      {pick && (
                        <div className={s.filter}>
                          <FilterField value={pick.filter} origin={pick.origin} reason={pick.reason} forName={pick.label}
                            onChange={(filter, origin) => edit(pick.key)({ filter, origin })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </fieldset>
        </>
      )}

      {hand.length > 0 && (
        <div className={s.rows}>
          {hand.map((p) => (
            <HandRow key={p.key} pick={p} onChange={edit(p.key)} onRemove={() => remove(p.key)} onEnterAgain={() => enterAgain(p.key)} />
          ))}
        </div>
      )}
      {handOpen ? form : (
        <button ref={addButton} type="button" className={s.addHand} onClick={onAddByHand}>+ Add a source by hand</button>
      )}
    </>
  );
}

function ReviewStep({ draft, setDraft, heading, clusterName, nameInput, nameError, onNameEdit, onEnter, installs }: StepProps & {
  clusterName: string; nameInput: RefObject<HTMLInputElement | null>; nameError: string | null; onNameEdit(): void; onEnter(): void;
  installs: Component[];
}) {
  const ids = useId();
  const what = draft.kind === "kubernetes" ? `Kubernetes cluster · ${clusterName}` : kindInfo(draft.kind ?? "custom").what;
  return (
    <>
      <h2 ref={heading} tabIndex={-1} className={s.stepTitle}>Name and review</h2>
      <p className={s.lead}>Nothing is saved until you create the project. Then its sources and filters are saved together.</p>
      <div className={s.nameField}>
        <label htmlFor={`${ids}-name`}>Name</label>
        <input id={`${ids}-name`} ref={nameInput} className={s.input} type="text" autoComplete="off" maxLength={80}
          aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? `${ids}-err` : undefined}
          value={draft.name}
          onChange={(e) => { onNameEdit(); const name = e.target.value; setDraft((d) => ({ ...d, name })); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); onEnter(); } }} />
        {nameError && <span id={`${ids}-err`} className={s.problem} role="alert">{nameError}</span>}
      </div>
      <ul className={s.summary} aria-label="Summary">
        <li className={s.summaryWhat}>What: {what}</li>
        {inUse(draft).map((p) => (
          <li key={p.key} className={s.summaryRow}>
            <span>{`${p.label} · ${"existingId" in p.source ? "existing" : "new"}`}</span>
            <span className={s.summaryFilter}>{p.filter.trim() ? `Filter: ${p.filter.trim()}` : "Filter: none"}</span>
          </li>
        ))}
        {installs.map((c) => <li key={c} className={s.summaryInstall}>{INSTALL_WORDS[c].summary}</li>)}
      </ul>
      {installs.length > 0 && <p className={s.installNext}>You review the install right after the project is created.</p>}
    </>
  );
}

function SetupFlow({ view, tabId, nav, openInNewTab, onOpenSettings }: MonitoringPageProps) {
  const client = useQueryClient();
  const reviews = useInstallReviews();
  const start = view.page === "setup" ? view.clusterId ?? null : null;
  // A setup left mid-way in this tab comes back (for the same start), without its secrets.
  const [restored] = useState(() => readSetupDraft(tabId, start ?? ""));
  const [draft, setDraftState] = useState<SetupDraft>(() => restored?.draft ?? ({
    step: start ? 2 : 1, kind: start ? "kubernetes" : null, clusterId: start, picks: [], name: "", install: NO_INSTALL,
  }));
  const setDraft = useCallback((update: (d: SetupDraft) => SetupDraft) => setDraftState(update), []);
  const clusters = useClusters();
  const sources = useSources();
  const discovery = useDiscovery(draft.step >= 2 && draft.kind === "kubernetes" ? draft.clusterId : null);
  const onCluster = draft.kind === "kubernetes" && draft.clusterId !== null;
  const tools = useQuery({ queryKey: installKeys.tools, queryFn: () => installTools(), enabled: onCluster && draft.step >= 2 });
  const offer: Offer = !onCluster ? null
    : tools.data ? (tools.data.available ? { available: true } : { available: false, why: tools.data.message ?? "OmniKrux can't install tools here." })
    : tools.isError ? { available: false, why: failure(tools.error, "try again") }
    : null;
  const installOffered = offer?.available === true;
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameTouched = useRef(restored?.named ?? false);
  const busyRef = useRef(false);
  const [handOpen, setHandOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handCount = useRef(Math.max(0, ...draft.picks.map((p) => (isHand(p) ? Number(p.key.slice("hand:".length)) || 0 : 0))));
  const reasonId = useId();

  const clusterName = clusters.data?.find((c) => c.id === draft.clusterId)?.name
    ?? (discovery.data?.cluster_id === draft.clusterId ? discovery.data?.cluster_name : undefined)
    ?? draft.clusterId ?? "";
  const existing = sources.data ?? (sources.isError ? EMPTY : undefined);

  // What discovery found becomes picks, once the known sources are in (to reuse them).
  useEffect(() => {
    const d = discovery.data;
    if (!d || existing === undefined) return;
    const missing = new Set(d.found.filter((t) => t.state === "missing").map((t) => t.type));
    setDraftState((cur) => (cur.kind === "kubernetes" && cur.clusterId === d.cluster_id ? mergeFound(cur, picksFromDiscovery(d, existing), missing) : cur));
  }, [discovery.data, existing]);

  // Where OmniKrux can't install, nothing is to be installed (a restored draft included).
  const cantInstall = tools.data?.available === false;
  useEffect(() => {
    if (cantInstall) setDraftState((cur) => (installComponents(cur).length > 0 ? { ...cur, install: NO_INSTALL } : cur));
  }, [cantInstall]);

  // The draft is kept in this browser once typing settles, and as the page closes; never once the
  // project is created. What is kept holds no secret (setupDraftStore).
  const created = useRef(false);
  const latest = useRef({ draft, named: nameTouched.current });
  latest.current = { draft, named: nameTouched.current };
  const keep = useCallback(() => {
    if (!created.current) writeSetupDraft(tabId, start ?? "", latest.current.draft, latest.current.named);
  }, [tabId, start]);
  useEffect(() => {
    const timer = window.setTimeout(keep, KEEP_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [draft, keep]);
  useEffect(() => () => keep(), [keep]);

  // A Kubernetes project asks OmniKrux which filter each source needs. A plain call, never cached:
  // the body of a source added by hand can hold its secrets.
  useEffect(() => {
    const clusterId = draft.clusterId;
    if (draft.kind !== "kubernetes" || clusterId === null) return;
    const ask = draft.picks.filter((p) => p.suggestedFor !== clusterId);
    if (ask.length === 0) return;
    const keys = new Set(ask.map((p) => p.key));
    setDraftState((cur) => ({ ...cur, picks: cur.picks.map((x) => (keys.has(x.key) ? { ...x, suggestedFor: clusterId } : x)) }));
    for (const p of ask) {
      const body: SuggestIn = {
        cluster_id: clusterId, kind: "kubernetes",
        ...("existingId" in p.source ? { source_id: p.source.existingId } : { source: p.source.new }),
      };
      const apply = (patch: Pick<SetupPick, "filter" | "origin" | "reason">) => setDraftState((cur) => (cur.clusterId !== clusterId ? cur : {
        ...cur, picks: cur.picks.map((x) => (x.key === p.key && x.origin !== "user" ? { ...x, ...patch } : x)),
      }));
      suggestFilter(body).then(
        (out) => apply({ filter: out.filter, origin: out.origin, reason: out.reason }),
        (err) => apply({ filter: "", origin: "none", reason: `Couldn't suggest a filter: ${failure(err)}` }),
      );
    }
  }, [draft.picks, draft.kind, draft.clusterId]);

  // Moving to a step puts the keyboard on its heading; on arrival only if nothing else has it.
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || keyboardIsFree()) heading.current?.focus();
    arrived.current = true;
  }, [draft.step]);

  // The add-by-hand form closed: back to its button.
  const handWasOpen = useRef(false);
  useEffect(() => {
    if (handWasOpen.current && !handOpen) addButton.current?.focus();
    handWasOpen.current = handOpen;
  }, [handOpen]);

  const goTo = (step: SetupStep) => {
    setError(null);
    setHandOpen(false);
    setDraftState((d) => ({
      ...d, step,
      // Until a name is typed, it follows what is monitored: the cluster's name, or nothing.
      name: step === 4 && !nameTouched.current ? (d.kind === "kubernetes" ? clusterName : "") : d.name,
    }));
  };

  const collect = (body: SourceIn) => {
    const n = ++handCount.current;
    const label = body.name?.trim() || `${autoTypeName(body.type)} · ${hostOf(body.url) || "address"}`;
    setDraftState((d) => ({
      ...d, picks: [...d.picks, { key: `hand:${n}`, label, detail: body.url ?? "", use: true, source: { new: body }, filter: "", origin: "none", reason: null }],
    }));
    setHandOpen(false);
  };

  async function create() {
    if (busyRef.current || blockedBy(draft, { installOffered }) !== null) return;
    const components = installOffered ? installComponents(draft) : [];
    const clusterId = draft.clusterId;
    busyRef.current = true;
    setBusy(true);
    setNameError(null);
    setError(null);
    try {
      // A plain call, not a mutation: TanStack would keep this body (secrets in it) in its cache.
      const made = await setupProject(setupBody(draft));
      created.current = true;
      removeSetupDraft(tabId);
      await invalidateMonitoring(client);
      // The page closes with the draft, and every secret typed into it.
      nav.navigate({ page: "project", id: made.id }, "replace");
      // The install is reviewed over the new project; closed, the keyboard goes to the project's name.
      if (components.length > 0 && clusterId !== null) {
        void reviews.install({ clusterId, components, projectId: made.id, focusAfter: projectHeading });
      }
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      if (err instanceof HttpError && err.status === 409) {
        setNameError(err.message);
        nameInput.current?.focus();
      } else {
        setError(failure(err, "try again"));
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && handOpen) {
      e.preventDefault();
      e.stopPropagation(); // the hand form's Esc; nothing around the page takes it too
      setHandOpen(false);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && draft.step === 4) {
      e.preventDefault();
      void create();
    }
  };

  const blocked = blockedBy(draft, { installOffered });
  const used = inUse(draft).length;
  const installs = installOffered ? installComponents(draft) : [];
  const stepNote = (n: number): string | null => {
    if (n === 1 && draft.kind) return draft.kind === "kubernetes" && clusterName ? `${clusterName} · Kubernetes` : kindInfo(draft.kind).what;
    if (n === 2 && draft.step > 2) return inUseAndInstalls(used, installs.length);
    if (n === 3) return "Comes later";
    return null;
  };
  const stepProps: StepProps = { draft, setDraft, heading };

  return (
    <section className={s.setup} aria-labelledby="monitoring-setup-title" onKeyDown={onKeyDown}>
      <nav className={s.rail} aria-label="Setup">
        <h1 id="monitoring-setup-title" className={s.title}>New project</h1>
        <ol className={s.steps} aria-label="Steps">
          {STEPS.map((st) => {
            const state = st.n === 3 ? "later" : st.n === draft.step ? "current" : st.n < draft.step ? "done" : "next";
            const note = stepNote(st.n);
            return (
              <li key={st.n} className={s.step} data-state={state} aria-current={state === "current" ? "step" : undefined}>
                <span className={s.stepNo} aria-hidden="true">{state === "done" ? "✓" : st.n}</span>
                <span className={s.stepText}>
                  {st.title}
                  {note && <small>{note}</small>}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className={s.body}>
        <div className={s.content}>
          {draft.step === 1 && <KindStep {...stepProps} clusters={clusters} onOpenSettings={onOpenSettings} />}
          {draft.step === 2 && (
            <SourcesStep {...stepProps} clusterName={clusterName} discovery={discovery} existing={sources} handOpen={handOpen} addButton={addButton}
              onAddByHand={() => setHandOpen(true)} offer={offer}
              onOpenTools={(e) => {
                if (draft.clusterId === null) return;
                const target = { page: "tools", clusterId: draft.clusterId } as const;
                if (e.ctrlKey || e.metaKey) openInNewTab(target);
                else nav.navigate(target, "push");
              }}
              form={<div className={s.handForm}><SourceForm mode="collect" onCollect={collect} onCancel={() => setHandOpen(false)} /></div>} />
          )}
          {draft.step === 4 && (
            <ReviewStep {...stepProps} clusterName={clusterName} nameInput={nameInput} nameError={nameError}
              onNameEdit={() => { nameTouched.current = true; setNameError(null); }} onEnter={() => void create()} installs={installs} />
          )}
          {error && <p className={s.problem} role="alert">{error}</p>}
        </div>

        <footer className={s.foot}>
          {draft.step > 1 && (
            <button type="button" className={s.secondary} onClick={() => goTo(draft.step === 4 ? 2 : 1)}>Back</button>
          )}
          {draft.step === 2 && <span className={s.sum}>{inUseAndInstalls(used, installs.length)}</span>}
          {blocked && <span id={reasonId} className={s.reason}>{blocked}</span>}
          {draft.step === 4 ? (
            <button type="button" className={s.primary} disabled={blocked !== null} aria-disabled={busy || undefined}
              aria-describedby={blocked ? reasonId : undefined} onClick={() => void create()}>
              {busy ? "Creating…" : installs.length > 0 ? "Create project and review the install" : "Create project"}
            </button>
          ) : (
            <button type="button" className={s.primary} disabled={blocked !== null} aria-describedby={blocked ? reasonId : undefined}
              onClick={() => goTo(draft.step === 1 ? 2 : 4)}>Continue</button>
          )}
        </footer>
      </div>
    </section>
  );
}

/** The setup page. A new start (another cluster) begins a new draft. */
export default function SetupPage(props: MonitoringPageProps) {
  const start = props.view.page === "setup" ? props.view.clusterId ?? "" : "";
  return <SetupFlow key={start} {...props} />;
}
