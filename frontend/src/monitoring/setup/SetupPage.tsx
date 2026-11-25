import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import type { Cluster } from "../../api/types";
import { useClusters } from "../../api/useClusters";
import { setupProject, suggestFilter } from "../api/client";
import { invalidateMonitoring, useDiscovery, useSources } from "../api/hooks";
import type { FoundTool, ProjectKind, ProjectOut, SourceIn, SourceOut, SuggestIn } from "../api/types";
import { readyViewTitles, readyViewsPhrase } from "../dashboards/readyViews";
import { useToolReviews } from "../alerts/reviews/useToolReviews";
import { markAlertForm } from "../alerts/rules/formSessions";
import { focusHeadingOnArrival, takeHeadingFocus } from "../dashboards/create/arrival";
import { GenerateTools, type AnsweredTools } from "../install/GenerateTools";
import { installKeys, installTools, type Component } from "../install/api";
import { useInstallReviews } from "../install/useInstallReviews";
import type { MonitoringPageProps } from "../MonitoringApp";
import { FilterField } from "../projects/FilterField";
import { DOT } from "../sidebar/Sidebar";
import { SourceForm } from "../sources/SourceForm";
import { autoTypeName, sourceTypeLabel, whereLabel } from "../sources/sourceLabels";
import { commitImport, previewImport, TransferRequestError, type GrafanaIn, type ImportResultOut } from "../transfer/api";
import { dashboardsWord } from "../transfer/grafanaLabels";
import { CHANGED } from "../transfer/importModel";
import { CHECKING, ImportStep, PreviewLedger, skippedWords, type ImportCheck } from "./ImportStep";
import { importFailedWords, noteImportFailed } from "./importNotice";
import { readSetupDraft, removeSetupDraft, SECRET_NOT_KEPT, writeSetupDraft } from "./setupDraftStore";
import {
  blockedBy, foundDetail, foundKey, grafanaFromDiscovery, hasImportStep, importable, importCommitBody, importSkipped, installComponents, INSTALLS, inUse, readyFor,
  isAnswered, NO_INSTALL, picksFromAnswered, picksFromDiscovery, setupBody, TOOL_NAMES,
  type SetupDraft, type SetupPick, type SetupStep,
} from "./setupModel";
import s from "./SetupPage.module.css";

const EMPTY: SourceOut[] = [];
const GENERATES = "OmniKrux connects to tools that already run there, or writes the files to install them for you to run.";
/** How long the draft waits for typing to settle before it is kept in this browser. */
const KEEP_AFTER_MS = 300;
/** How long the chosen Grafana dashboards settle before what converts is checked. */
const PREVIEW_AFTER_MS = 500;
const NO_READY = "No ready-made views: they come with a Prometheus-compatible or Loki source.";
const NOTHING_TO_IMPORT = "Nothing to import";
const CHECK_AGAIN = "Check what converts again on the Import step.";
const NONE_CONVERTS = "None of the chosen dashboards can be copied any more. Import them from the project instead.";

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
/** The tab's mark while its setup draft holds a choice: only closing the tab loses it. */
const SETUP_MARK = { title: "New project", page: "setup", closeOnly: true } as const;
const sourcesInUse = (n: number) => `${n} ${n === 1 ? "source" : "sources"} in use`;
const inUseAndInstalls = (n: number, m: number) => (m > 0 ? `${sourcesInUse(n)} · ${m} to install` : sourcesInUse(n));
/** Where the keyboard goes once the install review over a new project closes: its name. */
const projectHeading = () => document.getElementById("monitoring-project-title");

/** Calls `then` with the project's heading once its page shows, or null when it doesn't within a while. */
function whenProjectHeading(then: (heading: HTMLElement | null) => void) {
  const started = Date.now();
  const look = () => {
    const h = projectHeading();
    if (h && h.isConnected) return then(h);
    if (Date.now() - started > 10_000) return then(null);
    setTimeout(look, 40);
  };
  setTimeout(look, 0);
}

/** The same Grafana reached through the same cluster Service. */
const sameClusterGrafana = (a: GrafanaIn, b: GrafanaIn) =>
  a.reach === "cluster" && a.cluster_id === b.cluster_id && a.namespace === b.namespace && a.service === b.service && a.port === b.port;

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
  return { ...draft, kind, clusterId, picks, install: NO_INSTALL, importFrom: null };
}

function Chip({ tone, children }: { tone: "ok" | "bad" | "warn" | "plain" | "focus"; children: ReactNode }) {
  return <span className={s.chip} data-tone={tone}>{children}</span>;
}

function Badge({ type }: { type: FoundTool["type"] }) {
  return <span className={s.badge} data-type={type} aria-hidden="true">{TOOL_NAMES[type][0]}</span>;
}

/** Under a source in use: the ready-made views it brings to the project (none for other types). */
function ComesWith({ kind, type }: { kind: ProjectKind | null; type: FoundTool["type"] | undefined }) {
  if (type !== "prometheus" && type !== "loki") return null;
  const titles = readyViewTitles(kind ?? "custom", { prometheus: type === "prometheus", loki: type === "loki" });
  return <p className={s.later}>{`Comes with ${readyViewsPhrase(titles)}.`}</p>;
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

function FoundRow({ kind, tool, pick, existing, offer, installing, onChange, onInstall, onOpenTools }: {
  kind: ProjectKind | null; tool: FoundTool; pick: SetupPick | undefined; existing: SourceOut | undefined; offer: Offer; installing: boolean;
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
      {tool.type === "grafana" && tool.state === "reachable" && <p className={s.later}>You can copy its dashboards in the next step.</p>}
      {pick && <PickControls pick={pick} onChange={onChange} />}
      {pick?.use && <ComesWith kind={kind} type={tool.type} />}
    </div>
  );
}

function HandRow({ kind, pick, onChange, onRemove, onEnterAgain }: {
  kind: ProjectKind | null; pick: SetupPick; onChange(patch: Partial<SetupPick>): void; onRemove(): void; onEnterAgain(): void;
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
      <ComesWith kind={kind} type={type} />
    </div>
  );
}

/** A tool the generated files brought up: answering at its address, in use until removed. */
function AnsweredRow({ kind, pick, focusRow, onChange, onRemove }: {
  kind: ProjectKind | null; pick: SetupPick; focusRow: RefObject<string | null>; onChange(patch: Partial<SetupPick>): void; onRemove(): void;
}) {
  const type = "new" in pick.source ? pick.source.new.type : "prometheus";
  return (
    <div role="group" aria-label={pick.label} tabIndex={-1} className={s.row}
      ref={(el) => { if (el && focusRow.current === pick.key) { focusRow.current = null; el.focus(); } }}>
      <Badge type={type} />
      <div className={s.what}>
        <span className={s.toolName}>{pick.label}</span>
        <span className={s.detail}>{pick.detail}</span>
      </div>
      <div className={s.state}>
        <Chip tone="ok">Answering</Chip>
        <button type="button" className={s.quiet} onClick={onRemove}>Remove</button>
      </div>
      <div className={s.filter}>
        <FilterField value={pick.filter} origin={pick.origin} reason={pick.reason} forName={pick.label}
          onChange={(filter, origin) => onChange({ filter, origin })} />
      </div>
      <ComesWith kind={kind} type={type} />
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

function SourcesStep({ draft, setDraft, heading, clusterName, discovery, existing, onAddByHand, handOpen, addButton, form, offer, onOpenTools, onAnswered, focusRow }: StepProps & {
  onAnswered(tools: AnsweredTools): void; focusRow: RefObject<string | null>;
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
                  <FoundRow key={key} kind={draft.kind} tool={t} pick={byKey.get(key)} offer={offer}
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
          {(draft.kind === "docker" || draft.kind === "servers") && (
            <>
              <GenerateTools kind={draft.kind} onAnswered={onAnswered} />
              {draft.picks.some(isAnswered) && (
                <div className={s.rows}>
                  {draft.picks.filter(isAnswered).map((p) => (
                    <AnsweredRow key={p.key} kind={draft.kind} pick={p} focusRow={focusRow} onChange={edit(p.key)} onRemove={() => remove(p.key)} />
                  ))}
                </div>
              )}
            </>
          )}
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
                      {pick && <ComesWith kind={draft.kind} type={x.type} />}
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
            <HandRow key={p.key} kind={draft.kind} pick={p} onChange={edit(p.key)} onRemove={() => remove(p.key)} onEnterAgain={() => enterAgain(p.key)} />
          ))}
        </div>
      )}
      {handOpen ? form : (
        <button ref={addButton} type="button" className={s.addHand} onClick={onAddByHand}>+ Add a source by hand</button>
      )}
    </>
  );
}

function ReviewStep({ draft, setDraft, heading, clusterName, nameInput, nameError, onNameEdit, onEnter, installs, ready, importLine }: StepProps & {
  clusterName: string; nameInput: RefObject<HTMLInputElement | null>; nameError: string | null; onNameEdit(): void; onEnter(): void;
  installs: Component[]; ready: string[]; importLine: string;
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
        <li className={s.summaryImport}>{ready.length > 0 ? `Ready-made views: ${ready.join(", ")}` : NO_READY}</li>
        <li className={s.summaryImport}>{importLine}</li>
      </ul>
      {installs.length > 0 && <p className={s.installNext}>You review the install right after the project is created.</p>}
    </>
  );
}

/** The project exists but its import failed (no install was chosen): the page offers to retry. */
interface Created {
  project: ProjectOut;
  message: string;
  retrying: boolean;
  /** The import changed since it was checked: what converts was checked again and is shown; the next try imports it. */
  rechecked?: boolean;
}

function SetupFlow({ view, tabId, nav, openInNewTab, onOpenSettings }: MonitoringPageProps) {
  const client = useQueryClient();
  const reviews = useInstallReviews();
  const { enqueue } = useToolReviews();
  const start = view.page === "setup" ? view.clusterId ?? null : null;
  // A setup left mid-way in this tab comes back (for the same start), without its secrets. A
  // Grafana import whose sign-in wasn't kept goes back to step 3 to enter it again.
  const [restored] = useState(() => readSetupDraft(tabId, start ?? ""));
  const [draft, setDraftState] = useState<SetupDraft>(() => {
    const back = restored?.draft;
    if (back) return back.step === 4 && back.importFrom?.secretsDropped && back.importFrom.uids.length > 0 ? { ...back, step: 3 } : back;
    return { step: start ? 2 : 1, kind: start ? "kubernetes" : null, clusterId: start, picks: [], name: "", install: NO_INSTALL };
  });
  // Every choice made on the page goes through `setDraft`; what the page fills in itself doesn't.
  const [touched, setTouched] = useState(false);
  const setDraft = useCallback((update: (d: SetupDraft) => SetupDraft) => {
    setTouched(true);
    setDraftState(update);
  }, []);
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
  const [busy, setBusy] = useState<"project" | "import" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const tryAgain = useRef<HTMLButtonElement>(null);
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
  const made = useRef(false);
  const latest = useRef({ draft, named: nameTouched.current });
  latest.current = { draft, named: nameTouched.current };
  const keep = useCallback(() => {
    if (!made.current) writeSetupDraft(tabId, start ?? "", latest.current.draft, latest.current.named);
  }, [tabId, start]);
  useEffect(() => {
    const timer = window.setTimeout(keep, KEEP_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [draft, keep]);
  useEffect(() => () => keep(), [keep]);

  // A draft with any choice in it is kept per tab, so only closing the tab loses it: the tab is
  // marked for that alone (switching tabs, going elsewhere and reloading keep the draft). The mark
  // belongs to the tab, not to this page: it stays while the page is away (another tab shown, or
  // this one moved on) and goes with Discard, a created project, a draft with no choice left, or
  // the tab itself.
  const chosen = touched || draft.kind !== (start ? "kubernetes" : null) || draft.clusterId !== start || draft.step !== (start ? 2 : 1)
    || draft.name.trim() !== "" || draft.picks.some(isHand) || draft.importFrom != null;
  const chosenNow = useRef(chosen);
  chosenNow.current = chosen;
  useEffect(() => {
    markAlertForm(tabId, "setup", chosen ? SETUP_MARK : null);
  }, [tabId, chosen]);
  useEffect(() => () => {
    if (made.current || !chosenNow.current) markAlertForm(tabId, "setup", null);
  }, [tabId]);

  // --- Step 3: the Grafana found in the cluster --------------------------------------------------
  const found = discovery.data?.cluster_id === draft.clusterId ? discovery.data : undefined;
  const grafanaHere = hasImportStep(draft, found);
  // Once there is an import (step 3 was entered, or a draft brought one back), the step stays: a
  // later look inside the cluster doesn't take it, or what was typed into it, away.
  const importStep = onCluster && (grafanaHere || draft.importFrom != null);
  /** Step 3 is known not to exist: another kind, or the cluster's discovery found no reachable Grafana. */
  const noImport = draft.kind !== null && (!onCluster || (found !== undefined && !importStep));
  const grafanaTool = found?.found.find((t) => t.type === "grafana" && t.state === "reachable");
  /** Changes with every new connection (its dashboards load again). */
  const [connectionRev, setConnectionRev] = useState(0);
  /** The connection whose dashboards were chosen at least once: all start chosen only before that. */
  const [chosenRev, setChosenRev] = useState<number | null>(() => (restored?.draft.importFrom?.chosen || restored?.draft.importFrom?.uids.length ? 0 : null));
  const [check, setCheck] = useState<ImportCheck>({ state: "idle" });
  const [checkRun, setCheckRun] = useState(0);
  /** A restored import was checked against this cluster's discovery (F28), once. */
  const [restoreSettled, setRestoreSettled] = useState(() => !restored?.draft.importFrom && restored?.draft.step !== 3);

  // Restored, an import through the cluster whose Grafana discovery no longer reaches is dropped
  // (on step 3, the page goes to step 4 with nothing to import). One by its address stays: it
  // doesn't depend on the cluster. Only once, for the draft that came back.
  useEffect(() => {
    if (restoreSettled || (!found && !discovery.isError)) return;
    setRestoreSettled(true);
    if (grafanaHere) return;
    setDraftState((d) => (d.importFrom?.connection.reach === "url" ? d : { ...d, importFrom: null, step: d.step === 3 ? 4 : d.step }));
  }, [restoreSettled, found, grafanaHere, discovery.isError]);

  // Arriving on step 3, the Grafana found in the cluster is the connection (one entered by its
  // address stays, and so does one already there when a later look no longer finds it).
  useEffect(() => {
    if (draft.step !== 3 || !found || !restoreSettled) return;
    const g = grafanaFromDiscovery(found);
    setDraftState((d) => {
      const now = d.importFrom;
      if (!g) return now ? d : { ...d, step: 4 };
      if (now && (now.connection.reach === "url" || sameClusterGrafana(now.connection, g))) return d;
      return { ...d, importFrom: { connection: g, label: g.name ?? "Grafana", uids: [], preview: null } };
    });
  }, [draft.step, found, restoreSettled]);

  /** A restored import waits for discovery before it is used (an address doesn't). */
  const usable = restoreSettled || draft.importFrom?.connection.reach === "url";
  const restoring = !usable && (draft.importFrom?.uids.length ?? 0) > 0;
  const imp = importStep && usable ? (draft.importFrom ?? null) : null;
  /** Dashboards are chosen to import, through a connection that can load them. */
  const importChosen = imp !== null && !imp.secretsDropped && imp.uids.length > 0;
  const previewKey = importChosen && imp.preview === null ? `${connectionRev}|${imp.uids.join(",")}` : null;

  // What converts is checked once the choice settles (a plain call: the connection may carry a
  // token). A newer choice, or leaving, stops it; an answer for an older choice is dropped.
  useEffect(() => {
    if (previewKey === null) {
      setCheck({ state: "idle" });
      return;
    }
    const ctl = new AbortController();
    setCheck({ state: "checking" });
    const timer = window.setTimeout(() => {
      const asked = latest.current.draft.importFrom;
      if (!asked) return;
      previewImport({ input: { kind: "grafana", connection: asked.connection, uids: [...asked.uids] }, target: null }, ctl.signal).then(
        (p) => {
          if (ctl.signal.aborted) return;
          setDraftState((d) => (d.importFrom && d.importFrom.connection === asked.connection && d.importFrom.uids === asked.uids
            ? { ...d, importFrom: { ...d.importFrom, preview: p } } : d));
          setCheck({ state: "idle" });
        },
        (err: unknown) => {
          if (!ctl.signal.aborted) setCheck({ state: "failed", message: failure(err, "check again") });
        },
      );
    }, PREVIEW_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [previewKey, checkRun]);

  const onUids = (uids: string[]) => {
    setChosenRev(connectionRev);
    setDraftState((d) => {
      const i = d.importFrom;
      if (!i) return d;
      if (i.uids.length === uids.length && i.uids.every((u, n) => u === uids[n])) return i.chosen ? d : { ...d, importFrom: { ...i, chosen: true } };
      return { ...d, importFrom: { ...i, uids, preview: null, chosen: true } };
    });
  };
  const onConnection = (connection: GrafanaIn) => {
    const rev = connectionRev + 1;
    // Its sign-in entered again after a restore: the dashboards chosen before stay chosen.
    const kept = draft.importFrom?.secretsDropped ? draft.importFrom.uids : [];
    setConnectionRev(rev);
    if (kept.length > 0) setChosenRev(rev);
    setDraftState((d) => ({
      ...d, importFrom: { connection, label: connection.name ?? "Grafana", uids: kept, preview: null, ...(kept.length > 0 ? { chosen: true } : {}) },
    }));
  };
  const skipImport = () => {
    setDraftState((d) => (d.importFrom ? { ...d, importFrom: { ...d.importFrom, uids: [], preview: null } } : d));
    goTo(4);
  };

  /** What the import does: what step 4 lists, and whether Create waits for it. */
  const importReady = importChosen && imp.preview !== null && importable(imp.preview).length > 0;
  const importWait: string | null = restoring ? CHECKING : !importChosen || imp.preview !== null ? null
    : check.state === "failed" ? CHECK_AGAIN : CHECKING;
  const importLine = restoring ? `Import: ${CHECKING}` : !importChosen ? "Import: none"
    : imp.preview === null ? (check.state === "failed" ? `Import: ${check.message}` : `Import: ${CHECKING}`)
    : importable(imp.preview).length === 0 ? "Import: none"
    : `Import: ${dashboardsWord(importable(imp.preview).length)} from Grafana · ${skippedWords(importSkipped(imp.preview))}`;

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
  // From the sidebar's + New project, the keyboard comes to the heading too.
  useEffect(() => {
    if (arrived.current || takeHeadingFocus("setup") || keyboardIsFree()) heading.current?.focus();
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

  // The tools the generated files brought up become picks, in use; the keyboard goes to the first.
  const focusRow = useRef<string | null>(null);
  const onAnswered = useCallback((tools: AnsweredTools) => {
    const fresh = picksFromAnswered(tools);
    focusRow.current = fresh[0]?.key ?? null;
    setDraftState((d) => ({ ...d, picks: [...d.picks.filter((p) => !isAnswered(p)), ...fresh] }));
  }, []);

  const collect = (body: SourceIn) => {
    const n = ++handCount.current;
    const label = body.name?.trim() || `${autoTypeName(body.type)} · ${hostOf(body.url) || "address"}`;
    setDraftState((d) => ({
      ...d, picks: [...d.picks, { key: `hand:${n}`, label, detail: body.url ?? "", use: true, source: { new: body }, filter: "", origin: "none", reason: null }],
    }));
    setHandOpen(false);
  };

  /**
   * Creates the project, then copies the chosen Grafana dashboards into it, then opens it (the
   * install is reviewed over it). An import that fails after the project exists keeps this page with
   * a retry, unless an install was chosen: then the project says so and the install review opens.
   */
  async function create() {
    if (busyRef.current || created || blockedBy(draft, { installOffered }) !== null || importWait !== null) return;
    const components = installOffered ? installComponents(draft) : [];
    const clusterId = draft.clusterId;
    const willImport = importReady ? draft : null;
    busyRef.current = true;
    setBusy("project");
    setNameError(null);
    setError(null);
    let project: ProjectOut;
    try {
      // A plain call, not a mutation: TanStack would keep this body (secrets in it) in its cache.
      project = await setupProject(setupBody(draft));
    } catch (err) {
      busyRef.current = false;
      setBusy(null);
      if (err instanceof HttpError && err.status === 409) {
        setNameError(err.message);
        nameInput.current?.focus();
      } else {
        setError(failure(err, "try again"));
      }
      return;
    }
    made.current = true;
    // Made: nothing is left to lose when the tab closes.
    markAlertForm(tabId, "setup", null);
    removeSetupDraft(tabId);
    let result: ImportResultOut | null = null;
    let importError: string | null = null;
    const body = willImport ? importCommitBody(willImport, project.id) : null;
    if (body) {
      setBusy("import");
      try {
        // Plain too: the connection in it may carry a token.
        result = await commitImport(body);
      } catch (err) {
        importError = failure(err, "try again");
      }
    }
    await invalidateMonitoring(client);
    const installing = components.length > 0 && clusterId !== null;
    if (importError !== null && !installing) {
      busyRef.current = false;
      setBusy(null);
      setCreated({ project, message: importError, retrying: false });
      return;
    }
    if (importError !== null) noteImportFailed(project.id, importError);
    const changes = result?.alert_changes ?? [];
    // Nothing to review over it: the new project's page opens with the keyboard on its name.
    if (!installing && changes.length === 0) focusHeadingOnArrival("project", project.id);
    // The page closes with the draft, and every secret typed into it.
    nav.navigate({ page: "project", id: project.id }, "replace");
    if (installing) {
      // The install is reviewed over the new project; closed, the keyboard goes to the project's
      // name. The imported alerts' cluster reviews follow it.
      void reviews.install({ clusterId, components, projectId: project.id, focusAfter: projectHeading }).then(() => {
        if (changes.length > 0) enqueue(changes, { focus: projectHeading() });
      });
    } else if (changes.length > 0) {
      whenProjectHeading((h) => enqueue(changes, { focus: h }));
    }
  }

  /** The import again, into the project made already; a `changed` answer checks what converts first. */
  async function retryImport() {
    if (!created || created.retrying) return;
    const project = created.project;
    setCreated({ ...created, retrying: true });
    const fail = (err: unknown) => setCreated({ project, message: failure(err, "try again"), retrying: false });
    let out: ImportResultOut;
    try {
      const body = importCommitBody(latest.current.draft, project.id);
      if (!body) return fail(new Error(NONE_CONVERTS));
      out = await commitImport(body);
    } catch (err) {
      if (!(err instanceof TransferRequestError && err.code === "changed")) return fail(err);
      // Changed since it was checked: check it again for the project and show what converts now.
      // Nothing is imported until the next try, so nothing new is skipped unseen.
      try {
        const asked = latest.current.draft.importFrom;
        if (!asked) return fail(new Error(NONE_CONVERTS));
        const p = await previewImport({ input: { kind: "grafana", connection: asked.connection, uids: [...asked.uids] }, target: { kind: "project", id: project.id } });
        setDraftState((d) => (d.importFrom === asked ? { ...d, importFrom: { ...asked, preview: p } } : d));
        setCreated({ project, message: failure(err, "try again"), retrying: false, rechecked: true });
      } catch (again) {
        fail(again);
      }
      return;
    }
    await invalidateMonitoring(client);
    nav.navigate({ page: "project", id: project.id }, "replace");
    const changes = out.alert_changes;
    if (changes.length > 0) whenProjectHeading((h) => enqueue(changes, { focus: h }));
  }

  // The import failed after the project was made: the keyboard goes to the retry.
  useLayoutEffect(() => {
    if (created && !created.retrying) tryAgain.current?.focus();
  }, [created]);

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
  const reason = blocked ?? (draft.step === 4 ? importWait : null);
  const used = inUse(draft).length;
  const installs = installOffered ? installComponents(draft) : [];
  const ready = readyFor(draft, new Map((sources.data ?? []).map((x) => [x.id, x.type])), installs);
  const copying = importReady && imp.preview ? importable(imp.preview).length : 0;
  const stepNote = (n: number): string | null => {
    if (n === 1 && draft.kind) return draft.kind === "kubernetes" && clusterName ? `${clusterName} · Kubernetes` : kindInfo(draft.kind).what;
    if (n === 2 && draft.step > 2) return inUseAndInstalls(used, installs.length);
    if (n === 3 && noImport) return NOTHING_TO_IMPORT;
    if (n === 3 && draft.step > 3 && copying > 0) return `${dashboardsWord(copying)} to copy`;
    return null;
  };
  const stepProps: StepProps = { draft, setDraft, heading };
  const createLabel = busy === "project" ? "Creating project…" : busy === "import" ? "Importing dashboards…"
    : installs.length > 0 && importReady ? "Create project, import and review the install"
    : installs.length > 0 ? "Create project and review the install" : "Create project";
  const next: SetupStep = draft.step === 1 ? 2 : draft.step === 2 && importStep ? 3 : 4;
  const back: SetupStep = draft.step === 4 ? (importStep ? 3 : 2) : draft.step === 3 ? 2 : 1;

  return (
    <section className={s.setup} aria-labelledby="monitoring-setup-title" onKeyDown={onKeyDown}>
      <nav className={s.rail} aria-label="Setup">
        <h1 id="monitoring-setup-title" className={s.title}>New project</h1>
        <ol className={s.steps} aria-label="Steps">
          {STEPS.map((st) => {
            const state = st.n === 3 && noImport ? "later" : st.n === draft.step ? "current" : st.n < draft.step ? "done" : "next";
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
              onAddByHand={() => setHandOpen(true)} offer={offer} onAnswered={onAnswered} focusRow={focusRow}
              onOpenTools={(e) => {
                if (draft.clusterId === null) return;
                const target = { page: "tools", clusterId: draft.clusterId } as const;
                if (e.ctrlKey || e.metaKey) openInNewTab(target);
                else nav.navigate(target, "push");
              }}
              form={<div className={s.handForm}><SourceForm mode="collect" tabId={tabId} page="setup" onCollect={collect} onCancel={() => setHandOpen(false)} /></div>} />
          )}
          {draft.step === 3 && (
            <>
              {/* One heading whatever shows under it: the keyboard stays on it while the step fills in. */}
              <h2 ref={heading} tabIndex={-1} className={s.stepTitle}>Import from Grafana</h2>
              {imp ? (
                <ImportStep heading={heading} clusterName={clusterName} tool={grafanaTool} imp={imp} connectionRev={connectionRev}
                  defaultAll={chosenRev !== connectionRev} check={check} onUids={onUids} onConnection={onConnection}
                  onCheckAgain={() => setCheckRun((n) => n + 1)} onSkip={skipImport} />
              ) : discovery.isError && !found ? (
                <div className={s.note} role="alert">
                  <p>{failure(discovery.error, "look again")}</p>
                  <button type="button" className={s.secondary} onClick={skipImport}>Skip import</button>
                </div>
              ) : <p className={s.note} role="status">{`Looking inside ${clusterName}…`}</p>}
            </>
          )}
          {draft.step === 4 && !created && (
            <ReviewStep {...stepProps} clusterName={clusterName} nameInput={nameInput} nameError={nameError}
              onNameEdit={() => { nameTouched.current = true; setNameError(null); }} onEnter={() => void create()} installs={installs} ready={ready}
              importLine={importLine} />
          )}
          {created && (
            <div className={s.created}>
              <h2 ref={heading} tabIndex={-1} className={s.stepTitle}>{created.project.name}</h2>
              {/* Checked again after a `changed` answer: the line says so, never the answer's "Check again". */}
              <p className={s.problem} role="alert">
                {importFailedWords(created.rechecked && draft.importFrom?.preview ? CHANGED : created.message)}
              </p>
              {created.rechecked && draft.importFrom?.preview && (
                <div className={s.createdLedger}>
                  <PreviewLedger preview={draft.importFrom.preview} />
                </div>
              )}
              <div className={s.createdActions}>
                {/* aria-disabled, not disabled: the button keeps the keyboard while it retries. */}
                <button ref={tryAgain} type="button" className={s.primary} aria-disabled={created.retrying || undefined} onClick={() => void retryImport()}>
                  {created.retrying ? "Importing dashboards…" : "Try the import again"}
                </button>
                <button type="button" className={s.secondary} aria-disabled={created.retrying || undefined}
                  onClick={() => { if (!created.retrying) nav.navigate({ page: "project", id: created.project.id }, "replace"); }}>
                  Open the project
                </button>
              </div>
            </div>
          )}
          {error && <p className={s.problem} role="alert">{error}</p>}
        </div>

        {!created && (
          <footer className={s.foot}>
            {draft.step > 1 && (
              <button type="button" className={s.secondary} onClick={() => goTo(back)}>Back</button>
            )}
            {draft.step === 2 && <span className={s.sum}>{inUseAndInstalls(used, installs.length)}</span>}
            {draft.step === 3 && (
              <span className={s.sum}>{copying > 0 ? `${inUseAndInstalls(used, installs.length)} · ${dashboardsWord(copying)} to copy` : inUseAndInstalls(used, installs.length)}</span>
            )}
            {reason && <span id={reasonId} className={s.reason}>{reason}</span>}
            {draft.step === 4 ? (
              <button type="button" className={s.primary} disabled={reason !== null} aria-disabled={busy !== null || undefined}
                aria-describedby={reason ? reasonId : undefined} onClick={() => void create()}>
                {createLabel}
              </button>
            ) : (
              <button type="button" className={s.primary} disabled={blocked !== null} aria-describedby={blocked ? reasonId : undefined}
                onClick={() => goTo(next)}>
                {draft.step === 3 && !importChosen ? "Continue without importing" : "Continue"}
              </button>
            )}
          </footer>
        )}
      </div>
    </section>
  );
}

/** The setup page. A new start (another cluster) begins a new draft. */
export default function SetupPage(props: MonitoringPageProps) {
  const start = props.view.page === "setup" ? props.view.clusterId ?? "" : "";
  return <SetupFlow key={start} {...props} />;
}
