import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import { deleteSource, sourceDeleteReview, testSource } from "../api/client";
import { invalidateMonitoring, useSourceHealth, useSources } from "../api/hooks";
import type { HealthOut, SourceDeleteReviewOut, SourceOut } from "../api/types";
import { ageNote, STATE_WORDS, stateOf } from "../home/ProjectCard";
import { GrafanaConnections } from "../transfer/GrafanaConnections";
import type { MonitoringPageProps } from "../MonitoringApp";
import { SourceDeleteReview } from "./SourceDeleteReview";
import { SourceForm } from "./SourceForm";
import { sourceTypeLabel, whereLabel } from "./sourceLabels";
import s from "./SourcesPage.module.css";

const UNKNOWN: HealthOut = { state: "unknown", message: null, version: null, checked_at: null };
const STALE_REVIEW = "Something changed since the review. Review it again.";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | null;

export default function SourcesPage({ nav, openInNewTab, tabId }: MonitoringPageProps) {
  const client = useQueryClient();
  const sources = useSources();
  const healthQuery = useSourceHealth();
  const title = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});
  const [review, setReview] = useState<{ id: string; data: SourceDeleteReviewOut } | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  /** Put the keyboard back where the user was working; if that is gone, on the page title. */
  const returnFocus = useCallback(() => {
    // After the form has closed and the page has drawn again.
    setTimeout(() => {
      const back = opener.current;
      (back && back.isConnected && !(back as HTMLButtonElement).disabled ? back : title.current)?.focus();
    }, 0);
  }, []);

  const openForm = (next: Editing, from: HTMLElement) => { opener.current = from; setEditing(next); };
  const closeForm = () => { setEditing(null); returnFocus(); };

  const runTest = async (x: SourceOut) => {
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

  const askDelete = async (x: SourceOut, from: HTMLElement) => {
    opener.current = from;
    setPageError(null);
    setReviewError(null);
    try {
      setReview({ id: x.id, data: await sourceDeleteReview(x.id) });
    } catch (err) {
      setPageError(failure(err));
    }
  };

  const confirmDelete = async () => {
    if (!review || reviewBusy) return;
    setReviewBusy(review.id);
    setReviewError(null);
    try {
      await deleteSource(review.id, review.data.token);
      setReview(null);
      setReviewBusy(null);
      await invalidateMonitoring(client);
      returnFocus();
    } catch (err) {
      setReviewBusy(null);
      if (err instanceof HttpError && err.status === 409) {
        setReviewError(STALE_REVIEW);
        try {
          setReview({ id: review.id, data: await sourceDeleteReview(review.id) });
        } catch (again) {
          setReviewError(failure(again));
        }
      } else {
        setReviewError(failure(err, "try again"));
      }
    }
  };

  // The list changes under the review (the source went elsewhere): there is nothing left to ask about.
  useEffect(() => {
    if (review && sources.data && !sources.data.some((x) => x.id === review.id)) setReview(null);
  }, [review, sources.data]);

  const list = sources.data;
  const health = healthQuery.data ?? {};
  const editingSource = editing?.kind === "edit" ? list?.find((x) => x.id === editing.id) : undefined;

  return (
    <section className={s.page} aria-labelledby="monitoring-sources-title">
      <header className={s.head}>
        <h1 id="monitoring-sources-title" ref={title} tabIndex={-1} className={s.title}>Sources</h1>
        <button type="button" className={s.primary} disabled={editing !== null} onClick={(e) => openForm({ kind: "new" }, e.currentTarget)}>Add a source</button>
      </header>

      {editing?.kind === "new" && (
        <SourceForm mode="save" closeOnEscape tabId={tabId} page="sources" onSaved={closeForm} onCancel={closeForm} />
      )}
      {editing?.kind === "edit" && editingSource && (
        <SourceForm key={editingSource.id} mode="save" closeOnEscape tabId={tabId} page="sources" initial={editingSource} onSaved={closeForm} onCancel={closeForm} />
      )}

      {pageError && <p className={s.note} role="alert">{pageError}</p>}
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
            const h = health[x.id] ?? UNKNOWN;
            const state = stateOf(h);
            const age = state === "unknown" ? null : ageNote(h.checked_at, Date.now());
            const test = tests[x.id];
            return (
              <li key={x.id} className={s.row}>
                <div className={s.main}>
                  <span className={s.name}>{x.name}</span>
                  <span className={s.kind}>{sourceTypeLabel(x.type)}</span>
                  <span className={s.where}>{whereLabel(x)}</span>
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
                <div className={s.meta}>
                  <span className={s.health} data-state={state} title={state === "down" ? (h.message ?? undefined) : undefined}>
                    <i className={s.pip} aria-hidden="true" />{STATE_WORDS[state]}{age ? ` · ${age}` : ""}
                  </span>
                  <span className={s.used}>
                    {x.used_by.length > 0 ? `Used by ${x.used_by.map((p) => p.name).join(", ")}` : "Not used by a project"}
                  </span>
                </div>
                <div className={s.buttons}>
                  <button type="button" className={s.quiet} aria-label={`Test ${x.name}`} disabled={test === "busy"} onClick={() => void runTest(x)}>
                    {test === "busy" ? "Testing…" : "Test"}
                  </button>
                  <button type="button" className={s.quiet} aria-label={`Edit ${x.name}`} onClick={(e) => openForm({ kind: "edit", id: x.id }, e.currentTarget)}>Edit</button>
                  <button type="button" className={s.quiet} aria-label={`Delete ${x.name}`} onClick={(e) => void askDelete(x, e.currentTarget)}>Delete</button>
                </div>
                {test && test !== "busy" && <p className={test.ok ? s.ok : s.bad} role="status">{test.text}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <GrafanaConnections tabId={tabId} />

      {review && (
        <SourceDeleteReview review={review.data} busy={reviewBusy !== null} error={reviewError} restoreFocusTo={opener}
          onCancel={() => { setReview(null); setReviewError(null); }} onConfirm={() => void confirmDelete()} />
      )}
    </section>
  );
}

/** One source's page: its form, as opened from a tab or a link. */
export function SourcePage({ view, nav, tabId }: MonitoringPageProps) {
  const sources = useSources();
  const id = view.page === "source" ? view.id : "";
  const source = sources.data?.find((x) => x.id === id);
  const back = () => nav.navigate({ page: "sources" }, "push");
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
  return (
    <section className={s.page} aria-labelledby="monitoring-source-title">
      <h1 id="monitoring-source-title" className={s.title}>{source.name}</h1>
      <SourceForm key={source.id} mode="save" tabId={tabId} page="source" pageId={source.id} initial={source} onSaved={back} onCancel={back} />
    </section>
  );
}
