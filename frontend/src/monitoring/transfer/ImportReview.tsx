// The review of an import, before anything is saved: where the dashboards go, which source each
// data source reads, and per dashboard whether it comes, under which title, and what of it won't be
// copied. Ctrl+Enter anywhere in it (outside a text area) imports.
import { useId, useState, type KeyboardEvent, type RefObject } from "react";
import type { ProjectKind, ProjectOut, TreeOut } from "../api/types";
import { sourceTypeLabel } from "../sources/sourceLabels";
import type { BundleInfoOut, MappingIn, NewGroupIn } from "./api";
import { SkippedList } from "./SkippedList";
import { SourceMappingTable } from "./SourceMappingTable";
import { TargetPicker } from "./TargetPicker";
import {
  NO_SECRETS, alertsWords, chosenCount, importWords, notImportableWords, panelsWords, summaryWords, targetKind, type ReviewState, type ReviewTarget,
} from "./importModel";
import s from "./ImportReview.module.css";

/** Refusals of a commit, each shown where it is about. */
export interface ReviewErrors {
  target?: string;
  group?: string;
  rows?: Record<string, string>;
  sources?: Record<string, string>;
  general?: string;
}

/** The elements the page puts the keyboard on after a refusal. */
export interface ReviewRefs {
  heading: RefObject<HTMLHeadingElement | null>;
  target: RefObject<HTMLSelectElement | null>;
  groupName: RefObject<HTMLInputElement | null>;
  setUp: RefObject<HTMLButtonElement | null>;
  titles: Map<string, HTMLInputElement>;
  sources: Map<string, HTMLSelectElement>;
}

export interface ImportReviewProps {
  review: ReviewState;
  tree: TreeOut | undefined;
  /** The target project as read now (its linked sources), else null. */
  project: ProjectOut | null;
  newGroup: NewGroupIn | null;
  /** Title problems by dashboard key (taken, empty, twice in this import). */
  problems: Record<string, string>;
  errors: ReviewErrors;
  notice: string | null;
  /** A new preview is on its way (another target). */
  checking: boolean;
  importing: boolean;
  canImport: boolean;
  refs: ReviewRefs;
  onTarget(next: ReviewTarget | null): void;
  onMapping(key: string, m: MappingIn): void;
  onChoose(key: string, patch: Partial<{ use: boolean; title: string }>): void;
  onImport(): void;
  onStartOver(): void;
  onSetUp(): void;
}

const KIND_WORDS: Record<ProjectKind, string> = {
  kubernetes: "A Kubernetes cluster",
  docker: "A Docker host",
  servers: "Servers",
  custom: "Something of your own",
};

function ProjectUsed({ bundle }: { bundle: BundleInfoOut }) {
  return (
    <details className={s.used}>
      <summary>What the exported project used</summary>
      <ul className={s.usedList}>
        {bundle.project_kind && <li>{KIND_WORDS[bundle.project_kind]}</li>}
        {bundle.cluster && <li>Cluster {bundle.cluster}</li>}
        {bundle.sources.map((x) => (
          <li key={x.key} className={s.usedSource}>
            {`${x.name} · ${sourceTypeLabel(x.type)} · ${x.where} · Filter: ${x.filter || "none"}`}
          </li>
        ))}
      </ul>
      <p className={s.usedNote}>{NO_SECRETS}</p>
    </details>
  );
}

export function ImportReview(props: ImportReviewProps) {
  const { review, tree, project, problems, errors, notice, checking, importing, canImport, refs } = props;
  const ids = useId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const p = review.preview;
  const kind = targetKind(review.target);
  const n = chosenCount(review);

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    props.onImport();
  };

  return (
    <section className={s.review} aria-label="Review the import" onKeyDown={onKey} aria-busy={checking || undefined}>
      <header className={s.head}>
        <h2 ref={refs.heading} tabIndex={-1} className={s.title}>Review</h2>
        <p className={s.format}>{p.format_label}</p>
      </header>
      {notice && <p className={s.notice} role="alert">{notice}</p>}

      <TargetPicker kinds={p.target_kinds} tree={tree} value={review.target} onChange={props.onTarget} newGroup={props.newGroup}
        error={errors.target} groupError={errors.group} selectRef={refs.target} groupNameRef={refs.groupName}
        onSetUp={props.onSetUp} setUpRef={refs.setUp} />

      {p.bundle?.kind === "project" && <ProjectUsed bundle={p.bundle} />}

      {p.sources.length > 0 && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>Data sources</h3>
          <SourceMappingTable refs={p.sources} project={kind === "project" ? project : null} ownerKind={kind}
            value={review.mapping} onChange={props.onMapping} errors={errors.sources}
            selectRef={(key, el) => { if (el) refs.sources.set(key, el); else refs.sources.delete(key); }} />
        </div>
      )}

      <p className={s.summary} aria-live="polite">{summaryWords(review)}</p>

      <ul className={s.rows}>
        {p.dashboards.map((d) => {
          const c = review.chosen[d.key];
          const k = d.skipped.length;
          const base = `${ids}-${d.key}`;
          const problem = errors.rows?.[d.key] || problems[d.key];
          return (
            <li key={d.key} className={s.row} data-off={!c?.use || undefined}>
              <input type="checkbox" className={s.box} aria-label={`Import ${d.title}`} checked={!!c?.use} disabled={!d.importable}
                onChange={(e) => props.onChoose(d.key, { use: e.target.checked })} />
              <div className={s.rowMain}>
                {d.importable ? (
                  <div className={s.titleField}>
                    <label htmlFor={`${base}-t`} className={s.fieldLabel}>Title</label>
                    <input id={`${base}-t`} ref={(el) => { if (el) refs.titles.set(d.key, el); else refs.titles.delete(d.key); }}
                      className={s.input} type="text" autoComplete="off" aria-label={`Title for ${d.title}`} value={c?.title ?? ""}
                      disabled={!c?.use} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${base}-p` : undefined}
                      onChange={(e) => props.onChoose(d.key, { title: e.target.value })} />
                    {problem && c?.use && <p id={`${base}-p`} className={s.fieldError}>{problem}</p>}
                  </div>
                ) : (
                  <>
                    <span className={s.rowTitle}>{d.title}</span>
                    <p className={s.cant}>{notImportableWords(d)}</p>
                  </>
                )}
                <div className={s.facts}>
                  <span>{panelsWords(d.panels)}</span>
                  {d.alerts > 0 && <span>{alertsWords(d.alerts)}</span>}
                  {k > 0 && (
                    <button type="button" className={s.skippedButton} aria-expanded={!!open[d.key]} aria-controls={`${base}-s`}
                      onClick={() => setOpen((o) => ({ ...o, [d.key]: !o[d.key] }))}>
                      Skipped ({k})
                    </button>
                  )}
                </div>
                {k > 0 && open[d.key] && <div id={`${base}-s`}><SkippedList items={d.skipped} /></div>}
              </div>
            </li>
          );
        })}
      </ul>

      {errors.general && <p className={s.generalError} role="alert">{errors.general}</p>}
      <div className={s.actions}>
        <button type="button" className={s.primary} aria-keyshortcuts="Control+Enter"
          aria-disabled={!canImport || importing || checking || undefined} onClick={props.onImport}>
          {importing ? "Importing…" : importWords(n)}
        </button>
        <button type="button" className={s.secondary} aria-disabled={importing || undefined} onClick={props.onStartOver}>Start over</button>
        <span className={s.keyHint} aria-hidden="true">Ctrl+Enter</span>
      </div>
    </section>
  );
}
