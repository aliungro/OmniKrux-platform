import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import type { Cluster } from "../../api/types";
import { useClusters } from "../../api/useClusters";
import { setupProject, suggestFilter } from "../api/client";
import { invalidateMonitoring, useDiscovery, useSources } from "../api/hooks";
import type { FoundTool, ProjectKind, SourceIn, SourceOut, SuggestIn } from "../api/types";
import type { MonitoringPageProps } from "../MonitoringApp";
import { FilterField } from "../projects/FilterField";
import { DOT } from "../sidebar/Sidebar";
import { SourceForm } from "../sources/SourceForm";
import { sourceTypeLabel, whereLabel } from "../sources/sourceLabels";
import {
  blockedBy, foundDetail, foundKey, inUse, picksFromDiscovery, setupBody, TOOL_NAMES,
  type SetupDraft, type SetupPick, type SetupStep,
} from "./setupModel";
import s from "./SetupPage.module.css";

const EMPTY: SourceOut[] = [];
const LATER_INSTALL = "OmniKrux connects to tools that already run there. Generating files to install them comes in a later update.";

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

function hostOf(url: string | null | undefined): string {
  try { return new URL((url ?? "").trim()).hostname; } catch { return ""; }
}

/** Whether the page may take the keyboard as it appears: only when nothing else has it. */
function keyboardIsFree(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active.tagName === "MAIN") return true;
  return active.closest("[data-monitoring-page]") !== null;
}

/** Found picks replace the old ones; what the user changed on a pick that is still there is kept. */
function mergeFound(draft: SetupDraft, fresh: SetupPick[]): SetupDraft {
  const old = new Map(draft.picks.map((p) => [p.key, p]));
  const found = fresh.map((p) => {
    const was = old.get(p.key);
    return was ? { ...p, use: was.use, filter: was.filter, origin: was.origin, reason: was.reason } : p;
  });
  return { ...draft, picks: [...found, ...draft.picks.filter((p) => !p.key.startsWith("found:"))] };
}

/** Another kind or cluster: what was found or chosen goes; sources added by hand stay, their suggestions asked again. */
function retarget(draft: SetupDraft, kind: ProjectKind, clusterId: string | null): SetupDraft {
  if (draft.kind === kind && draft.clusterId === clusterId) return draft;
  const picks = draft.picks.filter(isHand).map((p) => (p.origin === "user" ? p : { ...p, filter: "", origin: "none" as const, reason: null }));
  return { ...draft, kind, clusterId, picks };
}

function Chip({ tone, children }: { tone: "ok" | "bad" | "warn" | "plain"; children: ReactNode }) {
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

function FoundRow({ tool, pick, existingName, onChange }: {
  tool: FoundTool; pick: SetupPick | undefined; existingName: string | undefined; onChange(patch: Partial<SetupPick>): void;
}) {
  const name = TOOL_NAMES[tool.type];
  const missing = tool.state === "missing";
  const chip = missing ? <Chip tone="warn">Missing</Chip>
    : tool.type === "grafana" ? <Chip tone="plain">Found</Chip>
    : tool.state === "reachable" ? <Chip tone="ok">Reachable</Chip>
    : <Chip tone="bad">Can&apos;t be reached</Chip>;
  return (
    <div role="group" aria-label={name} className={s.row} data-muted={missing || tool.type === "grafana" ? "" : undefined}>
      <Badge type={tool.type} />
      <div className={s.what}>
        <span className={s.toolName}>{name}</span>
        <span className={s.detail}>{missing ? "Not found in this cluster" : foundDetail(tool)}</span>
        {existingName && <span className={s.known}>Already a source: {existingName}</span>}
      </div>
      <div className={s.state}>
        {chip}
        {tool.state === "unreachable" && tool.message && <span className={s.why}>{tool.message}</span>}
      </div>
      {missing && <p className={s.later}>Installing it from here comes in a later update.</p>}
      {!missing && tool.type === "grafana" && <p className={s.later}>Importing its dashboards comes in a later update.</p>}
      {pick && <PickControls pick={pick} onChange={onChange} />}
    </div>
  );
}

function HandRow({ pick, onChange, onRemove }: { pick: SetupPick; onChange(patch: Partial<SetupPick>): void; onRemove(): void }) {
  const type = "new" in pick.source ? pick.source.new.type : "prometheus";
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
              <p>{clusters.error.message}</p>
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
      {(draft.kind === "docker" || draft.kind === "servers") && <p className={s.note}>{LATER_INSTALL}</p>}
    </>
  );
}

function SourcesStep({ draft, setDraft, heading, clusterName, discovery, existing, onAddByHand, handOpen, addButton, form }: StepProps & {
  clusterName: string; discovery: ReturnType<typeof useDiscovery>; existing: ReturnType<typeof useSources>; handOpen: boolean;
  onAddByHand(): void; addButton: RefObject<HTMLButtonElement | null>; form: ReactNode;
}) {
  const cluster = draft.kind === "kubernetes" && draft.clusterId !== null;
  const edit = (key: string) => (patch: Partial<SetupPick>) =>
    setDraft((d) => ({ ...d, picks: d.picks.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));
  const remove = (key: string) => {
    setDraft((d) => ({ ...d, picks: d.picks.filter((p) => p.key !== key) }));
    addButton.current?.focus();
  };
  const byKey = new Map(draft.picks.map((p) => [p.key, p]));
  const names = new Map((existing.data ?? EMPTY).map((x) => [x.id, x.name]));
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
          <p className={s.lead}>OmniKrux looked inside the cluster. Use what&apos;s there, or add a source by hand.</p>
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
                return (
                  <FoundRow key={`${key}:${t.state}`} tool={t} pick={byKey.get(key)}
                    existingName={t.existing_source_id ? names.get(t.existing_source_id) : undefined} onChange={edit(key)} />
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
            {existing.isError && !existing.data && <p className={s.problem} role="alert">{existing.error.message}</p>}
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
          {hand.map((p) => <HandRow key={p.key} pick={p} onChange={edit(p.key)} onRemove={() => remove(p.key)} />)}
        </div>
      )}
      {handOpen ? form : (
        <button ref={addButton} type="button" className={s.addHand} onClick={onAddByHand}>+ Add a source by hand</button>
      )}
    </>
  );
}

function ReviewStep({ draft, setDraft, heading, clusterName, nameInput, nameError, onNameEdit, onEnter }: StepProps & {
  clusterName: string; nameInput: RefObject<HTMLInputElement | null>; nameError: string | null; onNameEdit(): void; onEnter(): void;
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
      </ul>
    </>
  );
}

function SetupFlow({ view, nav, onOpenSettings }: MonitoringPageProps) {
  const client = useQueryClient();
  const start = view.page === "setup" ? view.clusterId ?? null : null;
  const [draft, setDraftState] = useState<SetupDraft>(() => ({
    step: start ? 2 : 1, kind: start ? "kubernetes" : null, clusterId: start, picks: [], name: "",
  }));
  const setDraft = useCallback((update: (d: SetupDraft) => SetupDraft) => setDraftState(update), []);
  const clusters = useClusters();
  const sources = useSources();
  const discovery = useDiscovery(draft.step >= 2 && draft.kind === "kubernetes" ? draft.clusterId : null);
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameTouched = useRef(false);
  const busyRef = useRef(false);
  const asked = useRef(new Set<string>());
  const [handOpen, setHandOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handCount = useRef(0);
  const reasonId = useId();

  const clusterName = clusters.data?.find((c) => c.id === draft.clusterId)?.name
    ?? (discovery.data?.cluster_id === draft.clusterId ? discovery.data?.cluster_name : undefined)
    ?? draft.clusterId ?? "";
  const existing = sources.data ?? (sources.isError ? EMPTY : undefined);

  // What discovery found becomes picks, once the known sources are in (to reuse them).
  useEffect(() => {
    const d = discovery.data;
    if (!d || existing === undefined) return;
    setDraftState((cur) => (cur.kind === "kubernetes" && cur.clusterId === d.cluster_id ? mergeFound(cur, picksFromDiscovery(d, existing)) : cur));
  }, [discovery.data, existing]);

  // A Kubernetes project asks OmniKrux which filter each source needs. A plain call, never cached:
  // the body of a source added by hand can hold its secrets.
  useEffect(() => {
    const clusterId = draft.clusterId;
    if (draft.kind !== "kubernetes" || clusterId === null) return;
    for (const p of draft.picks) {
      const id = `${clusterId}\n${p.key}`;
      if (asked.current.has(id)) continue;
      asked.current.add(id);
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
      name: step === 4 && !nameTouched.current && d.kind === "kubernetes" && d.name === "" ? clusterName : d.name,
    }));
  };

  const collect = (body: SourceIn) => {
    const n = ++handCount.current;
    const label = body.name?.trim() || `${body.type === "loki" ? "Loki" : "Prometheus"} · ${hostOf(body.url) || "address"}`;
    setDraftState((d) => ({
      ...d, picks: [...d.picks, { key: `hand:${n}`, label, detail: body.url ?? "", use: true, source: { new: body }, filter: "", origin: "none", reason: null }],
    }));
    setHandOpen(false);
  };

  async function create() {
    if (busyRef.current || blockedBy(draft) !== null) return;
    busyRef.current = true;
    setBusy(true);
    setNameError(null);
    setError(null);
    try {
      // A plain call, not a mutation: TanStack would keep this body (secrets in it) in its cache.
      const made = await setupProject(setupBody(draft));
      await invalidateMonitoring(client);
      // The page closes with the draft, and every secret typed into it.
      nav.navigate({ page: "project", id: made.id }, "replace");
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
      setHandOpen(false);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && draft.step === 4) {
      e.preventDefault();
      void create();
    }
  };

  const blocked = blockedBy(draft);
  const used = inUse(draft).length;
  const stepNote = (n: number): string | null => {
    if (n === 1 && draft.kind) return draft.kind === "kubernetes" && clusterName ? `${clusterName} · Kubernetes` : kindInfo(draft.kind).what;
    if (n === 2 && draft.step > 2) return sourcesInUse(used);
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
              onAddByHand={() => setHandOpen(true)}
              form={<div className={s.handForm}><SourceForm mode="collect" onCollect={collect} onCancel={() => setHandOpen(false)} /></div>} />
          )}
          {draft.step === 4 && (
            <ReviewStep {...stepProps} clusterName={clusterName} nameInput={nameInput} nameError={nameError}
              onNameEdit={() => { nameTouched.current = true; setNameError(null); }} onEnter={() => void create()} />
          )}
          {error && <p className={s.problem} role="alert">{error}</p>}
        </div>

        <footer className={s.foot}>
          {draft.step > 1 && (
            <button type="button" className={s.secondary} onClick={() => goTo(draft.step === 4 ? 2 : 1)}>Back</button>
          )}
          {draft.step === 2 && <span className={s.sum}>{sourcesInUse(used)}</span>}
          {blocked && <span id={reasonId} className={s.reason}>{blocked}</span>}
          {draft.step === 4 ? (
            <button type="button" className={s.primary} disabled={blocked !== null} aria-disabled={busy || undefined}
              aria-describedby={blocked ? reasonId : undefined} onClick={() => void create()}>
              {busy ? "Creating…" : "Create project"}
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
