// The Import page: pick what to import (a file, pasted JSON or a Grafana), check what converts,
// review where it goes, which sources it reads and what won't be copied, then import. Nothing is
// saved before Import; the commit is refused (409 `changed`) when anything differs from what was
// reviewed, and then the review is checked again. A file's text, the pasted JSON and the preview
// live in this page's state only: never a TanStack cache, a URL, the tab's state or the browser's
// storage (preview and commit are plain calls). Unsaved work holds the tab through the app's leave
// check, by its title only.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { getProject } from "../api/client";
import { invalidateMonitoring, projectKey, useMonitoringTree } from "../api/hooks";
import type { TreeOut } from "../api/types";
import { useLeaveGuard } from "../alerts/leave";
import { useToolReviews } from "../alerts/reviews/useToolReviews";
import { freeTitle } from "../dashboards/create/currentOwner";
import type { MonitoringPageProps } from "../MonitoringApp";
import {
  commitImport, previewImport, TransferRequestError,
  type ImportInput, type ImportPreviewOut, type ImportResultOut, type ImportedOut, type MappingIn, type NewGroupIn, type TargetIn,
} from "./api";
import { CONNECTING, ImportInputPicker, type InputMode } from "./ImportInputPicker";
import { ImportReview, type ReviewErrors, type ReviewRefs } from "./ImportReview";
import {
  CHANGED, LEAD, STALE, LEAVE_TITLE, MAX_FILE_BYTES, TOO_BIG, UNREADABLE, chosenCount, commitBody, initialReview, isNewGroup, rebaseReview,
  sameTarget, targetKind, titleProblem, type ReviewState, type ReviewTarget,
} from "./importModel";
import s from "./ImportPage.module.css";

type Focus = "review" | "target" | "group" | "imported" | "heading" | { title: string } | { source: string };

/** The review, the input it was checked with and the target the preview was made for. */
interface Reviewing {
  state: ReviewState;
  input: ImportInput;
  sent: TargetIn | null;
  /** A check of it failed: what shows is no longer known to be what would be imported. */
  stale?: boolean;
}

/** The target a preview is made for: a new group is previewed with none. */
const sentOf = (t: ReviewTarget | null): TargetIn | null => (t && !isNewGroup(t) ? t : null);

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

function exists(tree: TreeOut | undefined, t: TargetIn | null): boolean {
  if (!tree || !t) return false;
  return (t.kind === "project" ? tree.projects : tree.groups).some((x) => x.id === t.id);
}

/**
 * Calls `then` with the heading of the page that replaced `own` in this tab once it shows (a
 * dashboard loads first; another tab's page never counts), or with null when none shows within a
 * while: the reviews then return to the workspace.
 */
function whenHeadingShows(tabId: string, own: HTMLElement | null, then: (heading: HTMLElement | null) => void) {
  const started = Date.now();
  const look = () => {
    const h = document.querySelector<HTMLElement>(`[data-monitoring-page][data-monitoring-tab="${CSS.escape(tabId)}"] h1`);
    if (h && h !== own && h.isConnected) return then(h);
    if (Date.now() - started > 10_000) return then(null);
    setTimeout(look, 40);
  };
  setTimeout(look, 0);
}

export default function ImportPage({ view, tabId, nav, openInNewTab }: MonitoringPageProps) {
  const client = useQueryClient();
  const { enqueue } = useToolReviews();
  const tree = useMonitoringTree();
  const pageTarget = view.page === "import" ? (view.target ?? null) : null;

  const heading = useRef<HTMLHeadingElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const importedHeading = useRef<HTMLHeadingElement>(null);
  const refs: ReviewRefs = {
    heading: useRef<HTMLHeadingElement>(null),
    target: useRef<HTMLSelectElement>(null),
    groupName: useRef<HTMLInputElement>(null),
    setUp: useRef<HTMLButtonElement>(null),
    titles: useRef(new Map<string, HTMLInputElement>()).current,
    sources: useRef(new Map<string, HTMLSelectElement>()).current,
  };

  const [mode, setMode] = useState<InputMode>("file");
  const [file, setFile] = useState<{ name: string; size: number; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [paste, setPaste] = useState("");
  const [grafanaId, setGrafanaId] = useState("");
  const [uids, setUids] = useState<Set<string>>(() => new Set());
  /** A preview on its way: the first check of the input, or the review checked again. */
  const [checkingWhat, setCheckingWhat] = useState<"check" | "recheck" | null>(null);
  const checking = checkingWhat !== null;
  const [checkError, setCheckError] = useState<string | null>(null);
  const [review, setReview] = useState<Reviewing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReviewErrors>({});
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<ImportResultOut | null>(null);
  const [focus, setFocus] = useState<{ to: Focus } | null>(null);

  const changed = !done && (file !== null || paste.trim() !== "" || uids.size > 0 || review !== null);
  const guard = useLeaveGuard(undefined, changed, importing, { tabId, title: LEAVE_TITLE, page: "import" });

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);

  // The one preview on its way; a newer one, a changed input or leaving the page stops it.
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  const fileRead = useRef(0);

  const input: ImportInput | null = mode === "file"
    ? (file ? { kind: "text", text: file.text, file_name: file.name, via: "file" } : null)
    : mode === "paste"
      ? (paste.trim() !== "" ? { kind: "text", text: paste, via: "paste" } : null)
      : (grafanaId !== "" && grafanaId !== CONNECTING && uids.size > 0 ? { kind: "grafana", grafana_id: grafanaId, uids: [...uids] } : null);

  /** What the review was about changed: it no longer says what would be imported. */
  const inputChanged = () => {
    run.current?.abort();
    run.current = null;
    setCheckingWhat(null);
    setReview(null);
    setNotice(null);
    setErrors({});
    setCheckError(null);
  };

  async function previewFor(what: ImportInput, target: TargetIn | null): Promise<ImportPreviewOut | null> {
    run.current?.abort();
    const ctl = new AbortController();
    run.current = ctl;
    try {
      const p = await previewImport({ input: what, target }, ctl.signal);
      return ctl.signal.aborted ? null : p;
    } catch (err) {
      if (isAbort(err) || ctl.signal.aborted) return null;
      throw err;
    }
  }

  async function check() {
    if (!input || checking || reading) return;
    // Checked again with the review still showing (any change to the input closes it): the
    // choices made in it stay.
    if (review) {
      setNotice(null);
      if (await recheck(review, review.state.target, true)) setFocus({ to: "review" });
      return;
    }
    const what = input;
    setCheckingWhat("check");
    setCheckError(null);
    setNotice(null);
    setErrors({});
    try {
      const given = exists(tree.data, pageTarget) ? pageTarget : null;
      let p = await previewFor(what, given);
      if (!p) return;
      const fits = given !== null && p.target_kinds.includes(given.kind) ? given : null;
      const wanted = p.suggested_target && exists(tree.data, p.suggested_target) ? p.suggested_target : fits;
      if (!sameTarget(wanted, given)) {
        p = await previewFor(what, wanted);
        if (!p) return;
      }
      setReview({ state: initialReview(p, wanted), input: what, sent: wanted });
      setFocus({ to: "review" });
      setCheckingWhat(null);
    } catch (err) {
      setCheckError(failure(err, "check again"));
      setCheckingWhat(null);
    }
  }

  /** The same input previewed again for `target`; choices made by hand stay where they still fit. */
  async function recheck(base: Reviewing, target: ReviewTarget | null, sameTargetAsBefore: boolean): Promise<boolean> {
    const sent = sentOf(target);
    setCheckingWhat("recheck");
    try {
      const p = await previewFor(base.input, sent);
      if (!p) return false;
      setReview((r) => (r && r.input === base.input
        ? { input: r.input, sent, state: rebaseReview(r.state, p, r.state.target, sameTargetAsBefore) }
        : r));
      setCheckingWhat(null);
      return true;
    } catch (err) {
      // What shows was made for another place or before a change: never importable as it is.
      setReview((r) => (r && r.input === base.input ? { ...r, stale: true } : r));
      setNotice(null);
      setErrors((e) => ({ ...e, general: failure(err, "check again") }));
      setCheckingWhat(null);
      return false;
    }
  }

  const onTarget = (next: ReviewTarget | null) => {
    if (!review) return;
    setErrors((e) => ({ ...e, target: undefined, group: undefined }));
    const base = { ...review, state: { ...review.state, target: next } };
    setReview(base);
    const sent = sentOf(next);
    // Titles and suggestions depend on where the dashboards go: a new place is checked again.
    if (!sameTarget(sent, review.sent)) void recheck(base, next, false);
    else if (checkingWhat === "recheck") {
      // Back to the place the review was made for: the check for another one is no longer wanted.
      run.current?.abort();
      run.current = null;
      setCheckingWhat(null);
    }
  };

  const onMapping = (key: string, m: MappingIn) => {
    setErrors((e) => ({ ...e, sources: { ...e.sources, [key]: "" } }));
    setReview((r) => (r ? { ...r, state: { ...r.state, mapping: { ...r.state.mapping, [key]: m } } } : r));
  };
  const onChoose = (key: string, patch: Partial<{ use: boolean; title: string }>) => {
    setErrors((e) => ({ ...e, rows: { ...e.rows, [key]: "" } }));
    setReview((r) => (r ? { ...r, state: { ...r.state, chosen: { ...r.state.chosen, [key]: { ...r.state.chosen[key], ...patch } } } } : r));
  };

  async function chooseFile(f: File) {
    inputChanged();
    const token = ++fileRead.current;
    setFile(null);
    setFileError(null);
    // Refused before reading: a file this large is never loaded into the page.
    if (f.size > MAX_FILE_BYTES) return setFileError(TOO_BIG);
    setReading(true);
    try {
      const text = await f.text();
      if (token === fileRead.current) setFile({ name: f.name, size: f.size, text });
    } catch {
      if (token === fileRead.current) setFileError(UNREADABLE);
    } finally {
      if (token === fileRead.current) setReading(false);
    }
  }

  // --- Where the dashboards go ----------------------------------------------------------------
  const state = review?.state ?? null;
  const kind = state ? targetKind(state.target) : null;
  const projectId = state && state.target && !isNewGroup(state.target) && state.target.kind === "project" ? state.target.id : null;
  const project = useQuery({ queryKey: projectKey(projectId ?? ""), queryFn: () => getProject(projectId as string), enabled: projectId !== null });

  const owner = useMemo(() => {
    const t = state?.target ?? null;
    if (t === null || !tree.data) return { name: "", titles: new Set<string>() };
    if (isNewGroup(t)) return { name: t.newGroup.name.trim(), titles: new Set<string>() };
    const found = t.kind === "project" ? tree.data.projects.find((p) => p.id === t.id) : tree.data.groups.find((g) => g.id === t.id);
    return { name: found?.name ?? "", titles: new Set((found?.dashboards ?? []).filter((d) => !d.ready_made).map((d) => d.title)) };
  }, [state?.target, tree.data]);

  const problems = useMemo(() => {
    const out: Record<string, string> = {};
    if (!state) return out;
    for (const d of state.preview.dashboards) {
      const problem = titleProblem(state, d.key, owner.titles, owner.name);
      if (problem) out[d.key] = problem;
    }
    return out;
  }, [state, owner]);

  /** A group export's new group: its name made unique, and the projects the export named. */
  const newGroup = useMemo<NewGroupIn | null>(() => {
    const bundle = state?.preview.bundle;
    if (!bundle || bundle.kind !== "group" || !state?.preview.target_kinds.includes("group")) return null;
    const taken = new Set((tree.data?.groups ?? []).map((g) => g.name));
    const named = new Set(bundle.projects);
    return {
      name: freeTitle(bundle.name || "Imported group", taken),
      project_ids: (tree.data?.projects ?? []).filter((p) => named.has(p.name)).map((p) => p.id),
    };
  }, [state?.preview, tree.data]);

  // Only a review whose preview was made for this input and this place, and checked fine.
  const current = review !== null && !review.stale && sameTarget(review.sent, sentOf(review.state.target));
  const canImport = state !== null && current && chosenCount(state) > 0 && state.target !== null && Object.keys(problems).length === 0
    && !(isNewGroup(state.target) && state.target.newGroup.name.trim() === "");

  // --- Import -----------------------------------------------------------------------------------
  async function commit() {
    if (!review || importing || checking || !canImport) return;
    const body = commitBody(review.input, review.state);
    setImporting(true);
    setErrors({});
    setNotice(null);
    let out: ImportResultOut;
    try {
      out = await commitImport(body);
    } catch (err) {
      setImporting(false);
      return void refused(err);
    }
    // Imported: nothing here is unsaved any more, so leaving asks nothing.
    guard.discard();
    await invalidateMonitoring(client);
    setImporting(false);
    if (out.dashboards.length === 1) return openOne(out.dashboards[0], out);
    setDone(out);
    setFocus({ to: "imported" });
  }

  /** One dashboard: the tab shows it instead (recorded as opened); its reviews open over it. */
  function openOne(d: ImportedOut, out: ImportResultOut) {
    const own = heading.current;
    nav.navigate({ page: "dashboard", id: d.id }, "replace");
    if (out.alert_changes.length > 0) whenHeadingShows(tabId, own, (h) => enqueue(out.alert_changes, { focus: h }));
  }

  // Several: their reviews open over the list, and the keyboard comes back to its heading.
  const enqueued = useRef<ImportResultOut | null>(null);
  useEffect(() => {
    if (!done || enqueued.current === done) return;
    enqueued.current = done;
    if (done.alert_changes.length > 0) enqueue(done.alert_changes, { focus: importedHeading.current });
  }, [done, enqueue]);

  async function refused(err: unknown) {
    const words = failure(err, "try again");
    if (!(err instanceof TransferRequestError) || !review) return setErrors({ general: words });
    const key = err.key;
    const isRow = key !== null && review.state.preview.dashboards.some((d) => d.key === key);
    const isSource = key !== null && review.state.preview.sources.some((r) => r.key === key);
    if (err.code === "changed") {
      setNotice(CHANGED);
      if (await recheck(review, review.state.target, true)) setFocus({ to: "review" });
      return;
    }
    if ((err.code === "name_taken" || err.code === "not_importable") && isRow) {
      setErrors({ rows: { [key]: words } });
      return setFocus({ to: { title: key } });
    }
    if (err.code === "name_taken" && isNewGroup(review.state.target)) {
      setErrors({ group: words });
      return setFocus({ to: "group" });
    }
    if (err.status === 404) {
      setErrors({ target: words });
      return setFocus({ to: "target" });
    }
    if (err.code === "unlinked_source" && isSource) {
      setErrors({ sources: { [key]: words } });
      return setFocus({ to: { source: key } });
    }
    setErrors({ general: words });
  }

  const reset = () => {
    inputChanged();
    fileRead.current += 1;
    setFile(null);
    setFileError(null);
    setReading(false);
    setPaste("");
    setUids(new Set());
    setDone(null);
    setFocus({ to: "heading" });
  };

  useLayoutEffect(() => {
    if (!focus) return;
    const to = focus.to;
    const el: HTMLElement | null | undefined = to === "review" ? refs.heading.current
      : to === "target" ? (refs.target.current ?? refs.setUp.current)
      : to === "group" ? refs.groupName.current
      : to === "imported" ? importedHeading.current
      : to === "heading" ? heading.current
      : "title" in to ? refs.titles.get(to.title)
      : refs.sources.get(to.source);
    (el ?? refs.heading.current ?? heading.current)?.focus();
    setFocus(null);
    // Only when asked.
  }, [focus]);

  const onGrafana = useCallback((id: string) => { inputChanged(); setGrafanaId(id); }, []);

  return (
    <div className={s.page}>
      <header className={s.top}>
        <span className={s.mark} aria-hidden="true">⤓</span>
        <div>
          <h1 ref={heading} tabIndex={-1} className={s.title}>Import dashboards</h1>
          <p className={s.lead}>{LEAD}</p>
        </div>
      </header>

      {done ? (
        <Imported out={done} headingRef={importedHeading} onOpen={(d, newTab) => {
            const to = { page: "dashboard", id: d.id } as const;
            if (newTab) openInNewTab(to);
            else nav.navigate(to, "push");
          }}
          onMore={reset} />
      ) : (
        <>
          <ImportInputPicker tabId={tabId} mode={mode} onMode={(m) => { if (m !== mode) { inputChanged(); setMode(m); } }}
            file={file} fileError={fileError} reading={reading} onFile={(f) => void chooseFile(f)}
            paste={paste} onPaste={(t) => { inputChanged(); setPaste(t); }}
            grafanaId={grafanaId} onGrafana={onGrafana} uids={uids} onUids={(next) => { inputChanged(); setUids(next); }}
            canCheck={input !== null && !reading} checking={checkingWhat === "check"} error={checkError} onCheck={() => void check()} checkRef={checkRef} />

          {review && (
            <ImportReview review={review.state} tree={tree.data} project={kind === "project" ? (project.data ?? null) : null}
              newGroup={newGroup} problems={problems} errors={errors} notice={review.stale ? STALE : notice} checking={checkingWhat === "recheck"} importing={importing}
              canImport={canImport} refs={refs} onTarget={onTarget} onMapping={onMapping} onChoose={onChoose}
              onImport={() => void commit()} onStartOver={() => { if (!importing) reset(); }} onSetUp={() => openInNewTab({ page: "setup" })} />
          )}
        </>
      )}
    </div>
  );
}

function Imported({ out, headingRef, onOpen, onMore }: {
  out: ImportResultOut;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onOpen(d: ImportedOut, newTab: boolean): void;
  onMore(): void;
}) {
  const id = useId();
  const click = (d: ImportedOut) => (e: MouseEvent<HTMLButtonElement>) => onOpen(d, e.ctrlKey || e.metaKey);
  const key = (d: ImportedOut) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    onOpen(d, true);
  };
  return (
    <section className={s.done} aria-labelledby={id}>
      <h2 id={id} ref={headingRef} tabIndex={-1} className={s.doneTitle}>Imported</h2>
      <ul className={s.doneList}>
        {out.dashboards.map((d) => (
          <li key={d.id} className={s.doneRow}>
            <span className={s.doneName}>{d.title}</span>
            <button type="button" className={s.quiet} aria-label={`Open ${d.title}`} aria-keyshortcuts="Control+Enter"
              title="Ctrl+click or Ctrl+Enter opens it in a new tab" onClick={click(d)} onKeyDown={key(d)}>Open</button>
          </li>
        ))}
      </ul>
      {out.warnings.length > 0 && (
        <ul className={s.warnings}>
          {out.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <div>
        <button type="button" className={s.secondary} onClick={onMore}>Import more</button>
      </div>
    </section>
  );
}
