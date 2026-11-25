import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import { deleteSource, sourceDeleteReview, testSource } from "../api/client";
import { invalidateMonitoring, useSourceHealth, useSources } from "../api/hooks";
import type { HealthOut, SourceDeleteReviewOut, SourceOut } from "../api/types";
import { ageNote, stateOf } from "../home/ProjectCard";
import { GrafanaConnections } from "../transfer/GrafanaConnections";
import type { MonitoringPageProps } from "../MonitoringApp";
import { SourceDeleteReview } from "./SourceDeleteReview";
import { SourceForm, savedAfterFailedTest } from "./SourceForm";
import { sourceTypeLabel, stateWords, whereLabel } from "./sourceLabels";
import s from "./SourcesPage.module.css";

const UNKNOWN: HealthOut = { state: "unknown", message: null, version: null, checked_at: null };
const STALE_REVIEW = "Something changed since the review. Review it again.";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | null;
type TestState = { ok: boolean; text: string } | "busy";

/** The Test button of a stored source: its answer in words, kept per source. */
function useSourceTests() {
  const client = useQueryClient();
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const run = async (x: SourceOut) => {
    setTests((t) => ({ ...t, [x.id]: "busy" }));
    try {
      const out = await testSource(x.id);
      setTests((t) => ({ ...t, [x.id]: out.ok
        ? { ok: true, text: `Connected · version ${out.version ?? "unknown"}` }
        : { ok: false, text: out.message ?? "The source didn't answer. Check the address and sign-in, then test again." } }));
      void invalidateMonitoring(client);
    } catch (err) {
      setTests((t) => ({ ...t, [x.id]: { ok: false, text: failure(err, "test again") } }));
    }
  };
  return { tests, run };
}

/** Delete… for a stored source: the review, the confirm, and a stale review read again. */
function useSourceDelete(sources: SourceOut[] | undefined, afterDelete: () => void) {
  const client = useQueryClient();
  const opener = useRef<HTMLElement | null>(null);
  const [review, setReview] = useState<{ id: string; data: SourceDeleteReviewOut } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const ask = async (x: SourceOut, from: HTMLElement) => {
    opener.current = from;
    setPageError(null);
    setError(null);
    try {
      setReview({ id: x.id, data: await sourceDeleteReview(x.id) });
    } catch (err) {
      setPageError(failure(err));
    }
  };
  const confirm = async () => {
    if (!review || busy) return;
    setBusy(review.id);
    setError(null);
    try {
      await deleteSource(review.id, review.data.token);
      setReview(null);
      setBusy(null);
      await invalidateMonitoring(client);
      afterDelete();
    } catch (err) {
      setBusy(null);
      if (err instanceof HttpError && err.status === 409) {
        setError(STALE_REVIEW);
        try {
          setReview({ id: review.id, data: await sourceDeleteReview(review.id) });
        } catch (again) {
          setError(failure(again));
        }
      } else {
        setError(failure(err, "try again"));
      }
    }
  };
  const cancel = () => { setReview(null); setError(null); };
  // The list changes under the review (the source went elsewhere): there is nothing left to ask about.
  useEffect(() => {
    if (review && sources && !sources.some((x) => x.id === review.id)) setReview(null);
  }, [review, sources]);
  return { review, busy, error, pageError, opener, ask, confirm, cancel };
}

export default function SourcesPage({ nav, openInNewTab, tabId }: MonitoringPageProps) {
  const sources = useSources();
  const healthQuery = useSourceHealth();
  const title = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const { tests, run: runTest } = useSourceTests();
  const del = useSourceDelete(sources.data, () => returnFocus());

  /** Put the keyboard back where the user was working; if that is gone, on the page title. */
  const returnFocus = useCallback(() => {
    // After the form has closed and the page has drawn again.
    setTimeout(() => {
      const back = del.opener.current;
      (back && back.isConnected && !(back as HTMLButtonElement).disabled ? back : title.current)?.focus();
    }, 0);
  }, [del.opener]);

  const openForm = (next: Editing, from: HTMLElement) => { del.opener.current = from; setSaved(null); setEditing(next); };
  const closeForm = () => { setEditing(null); returnFocus(); };
  const savedForm = (done: SourceOut, info?: { failedTest: boolean }) => {
    setSaved(info?.failedTest ? savedAfterFailedTest(done.name) : null);
    closeForm();
  };

  const list = sources.data;
  const health = healthQuery.data ?? {};
  // Until the first health read answers, a row says it is being read, not that nothing was checked.
  const reading = healthQuery.data === undefined && !healthQuery.isError;
  const editingSource = editing?.kind === "edit" ? list?.find((x) => x.id === editing.id) : undefined;

  return (
    <section className={s.page} aria-labelledby="monitoring-sources-title">
      <header className={s.head}>
        <h1 id="monitoring-sources-title" ref={title} tabIndex={-1} className={s.title}>Sources</h1>
        <button type="button" className={s.primary} disabled={editing !== null} onClick={(e) => openForm({ kind: "new" }, e.currentTarget)}>Add a source</button>
      </header>

      {editing?.kind === "new" && (
        <SourceForm mode="save" closeOnEscape tabId={tabId} page="sources" onSaved={savedForm} onCancel={closeForm} />
      )}
      {editing?.kind === "edit" && editingSource && (
        <SourceForm key={editingSource.id} mode="save" closeOnEscape tabId={tabId} page="sources" initial={editingSource} onSaved={savedForm} onCancel={closeForm} />
      )}

      {saved && <p className={s.note} role="status">{saved}</p>}
      {del.pageError && <p className={s.note} role="alert">{del.pageError}</p>}
      {sources.isError && !list && (
        <div className={s.note} role="alert">
          <p>{failure(sources.error, "try again")}</p>
          <button type="button" className={s.secondary} onClick={() => void sources.refetch()}>Try again</button>
        </div>
      )}
      {!list && !sources.isError && <p className={s.note} role="status">Loading sources…</p>}
      {list && list.length === 0 && !editing && (
        <p className={s.empty}>No sources yet. Add one here or while setting up a project.</p>
      )}

      {list && list.length > 0 && (
        <ul className={s.list}>
          {list.map((x) => {
            const test = tests[x.id];
            return (
              <li key={x.id} className={s.row}>
                <div className={s.main}>
                  <span className={s.name}>{x.name}</span>
                  <span className={s.kind}>{sourceTypeLabel(x.type)}</span>
                  <span className={s.where} title={whereLabel(x)}>{whereLabel(x)}</span>
                  {x.installed_by_omnikrux && (
                    <span className={s.ours}>
                      <span className={s.chip}>Installed by OmniKrux</span>
                      {x.cluster_id && (
                        <button type="button" className={s.link} onClick={(e) => {
                          const target = { page: "tools", clusterId: x.cluster_id as string } as const;
                          if (e.ctrlKey || e.metaKey) openInNewTab(target);
                          else nav.navigate(target, "push");
                        }}>Monitoring tools</button>
                      )}
                    </span>
                  )}
                </div>
                <SourceFacts source={x} health={health[x.id] ?? UNKNOWN} reading={reading} />
                <div className={s.buttons}>
                  <button type="button" className={s.quiet} aria-label={`Test ${x.name}`} disabled={test === "busy"} onClick={() => void runTest(x)}>
                    {test === "busy" ? "Testing…" : "Test"}
                  </button>
                  <button type="button" className={s.quiet} aria-label={`Edit ${x.name}`} onClick={(e) => openForm({ kind: "edit", id: x.id }, e.currentTarget)}>Edit</button>
                  <button type="button" className={s.quiet} aria-label={`Delete ${x.name}`} onClick={(e) => void del.ask(x, e.currentTarget)}>Delete</button>
                </div>
                {test && test !== "busy" && <p className={test.ok ? s.ok : s.bad} role="status">{test.text}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <GrafanaConnections tabId={tabId} />

      {del.review && (
        <SourceDeleteReview review={del.review.data} busy={del.busy !== null} error={del.error} restoreFocusTo={del.opener}
          onCancel={del.cancel} onConfirm={() => void del.confirm()} />
      )}
    </section>
  );
}

/** A source's state and who uses it: the middle of a list row, and the top of the source's own page. */
function SourceFacts({ source: x, health: h, reading }: { source: SourceOut; health: HealthOut; reading: boolean }) {
  const state = reading ? "unknown" : stateOf(h);
  const age = state === "unknown" ? null : ageNote(h.checked_at, Date.now());
  const used = x.used_by.length > 0 ? `Used by ${x.used_by.map((p) => p.name).join(", ")}` : "Not used by a project";
  return (
    <div className={s.meta}>
      <span className={s.health} data-state={state} title={state === "down" ? (h.message ?? undefined) : undefined}>
        <i className={s.pip} aria-hidden="true" />{reading ? "Checking…" : stateWords(h, x.type)}{age ? ` · ${age}` : ""}
      </span>
      <span className={s.used} title={used}>{used}</span>
    </div>
  );
}

/** One source's page: its facts with Test and Delete…, then its form, as opened from a tab or a link. */
export function SourcePage({ view, nav, tabId }: MonitoringPageProps) {
  const sources = useSources();
  const healthQuery = useSourceHealth();
  const { tests, run } = useSourceTests();
  const id = view.page === "source" ? view.id : "";
  const source = sources.data?.find((x) => x.id === id);
  const back = () => nav.navigate({ page: "sources" }, "push");
  const del = useSourceDelete(sources.data, () => nav.navigate({ page: "sources" }, "replace"));
  if (!source && sources.isError && !sources.data) {
    return (
      <section className={s.page}>
        <div className={s.note} role="alert">
          <p>{failure(sources.error, "try again")}</p>
          <button type="button" className={s.secondary} onClick={() => void sources.refetch()}>Try again</button>
        </div>
      </section>
    );
  }
  if (!source) return <section className={s.page}><p className={s.note} role="status">Loading source…</p></section>;
  const test = tests[source.id];
  const reading = healthQuery.data === undefined && !healthQuery.isError;
  return (
    <section className={s.page} aria-labelledby="monitoring-source-title">
      <h1 id="monitoring-source-title" className={s.title}>{source.name}</h1>
      <div className={s.factsRow}>
        <SourceFacts source={source} health={healthQuery.data?.[source.id] ?? UNKNOWN} reading={reading} />
        <div className={s.buttons}>
          <button type="button" className={s.quiet} aria-label={`Test ${source.name}`} disabled={test === "busy"} onClick={() => void run(source)}>
            {test === "busy" ? "Testing…" : "Test"}
          </button>
          <button type="button" className={s.quiet} aria-label={`Delete ${source.name}`} onClick={(e) => void del.ask(source, e.currentTarget)}>Delete…</button>
        </div>
      </div>
      {test && test !== "busy" && <p className={test.ok ? s.ok : s.bad} role="status">{test.text}</p>}
      {del.pageError && <p className={s.note} role="alert">{del.pageError}</p>}
      <SourceForm key={source.id} mode="save" tabId={tabId} page="source" pageId={source.id} initial={source} onSaved={back} onCancel={back} />
      {del.review && (
        <SourceDeleteReview review={del.review.data} busy={del.busy !== null} error={del.error} restoreFocusTo={del.opener}
          onCancel={del.cancel} onConfirm={() => void del.confirm()} />
      )}
    </section>
  );
}
