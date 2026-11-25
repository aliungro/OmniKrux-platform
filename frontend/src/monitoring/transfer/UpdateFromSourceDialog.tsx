// Update an imported dashboard from where it came from. A Grafana that is still connected is read
// again at once; a file or pasted JSON (or a Grafana whose connection is gone) is asked for first.
// Then the difference: the dashboard now beside what the source makes of it, what won't be copied,
// and new data sources to map; nothing is written until Replace with the source, which the server
// refuses when the source or the dashboard changed since this review (the review then runs again).
// The replaced version stays in Versions. The file's text and the review live in this dialog's
// state only: plain calls, never a query or mutation cache.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import { invalidateMonitoring, useProjects } from "../api/hooks";
import { dashboardKey, type DashboardOut } from "../dashboards/api";
import { JsonDiff } from "../dashboards/JsonDiff";
import { dashboardJson, type DashboardSpec } from "../dashboards/schema";
import {
  applyUpdate, previewUpdate, TransferRequestError, type MappingIn, type OriginOut, type TextInput, type UpdateApplyIn, type UpdatePreviewIn,
  type UpdatePreviewOut,
} from "./api";
import { MAX_FILE_BYTES, sizeWords, TOO_BIG, UNREADABLE } from "./importModel";
import { SkippedList } from "./SkippedList";
import { SourceMappingTable } from "./SourceMappingTable";
import x from "./UpdateFromSourceDialog.module.css";

// --- Words -------------------------------------------------------------------------------------

export const UPDATE_REFUSED = "Save or discard your draft before updating from the source.";
export const SOURCE_CHANGED = "The source changed since you reviewed it. Here is the new difference.";
export const SAVED_ELSEWHERE = "This dashboard was saved somewhere else since you opened this. Review it again.";
export const EDITED_SINCE_IMPORT = "This dashboard was changed in OmniKrux since it was imported. Updating replaces those changes; they stay in Versions.";
export const NOTHING_CHANGED = "Nothing changed: the source matches this dashboard.";
export const updatedWords = (title: string) => `Updated "${title}" from its source.`;

/** The source line: where it comes from and, for a Grafana, which of its versions replaces which. */
export function fromWords(label: string, kind: OriginOut["kind"], preview: UpdatePreviewOut | null): string {
  const was = preview?.previous_source_version ?? null;
  const now = preview?.source_version ?? null;
  return kind === "grafana" && was !== null && now !== null ? `From ${label} · Grafana version ${was} → ${now}` : `From ${label}`;
}

/** Whether the source has to be given again: a file, pasted JSON, or a Grafana no longer connected. */
export const needsInput = (o: Pick<OriginOut, "via" | "can_refetch">) => o.via !== "grafana" || !o.can_refetch;

const asSpec = (doc: Record<string, unknown>) => doc as unknown as DashboardSpec;

export interface UpdateFromSourceDialogProps {
  dashboard: DashboardOut;
  origin: OriginOut;
  /**
   * `updated` true: the dashboard took the source (`out`: the server's answer, with its `alert_changes`).
   * `why` "refused": closed because `refuse()` said a draft or edit session exists now.
   */
  onClose(updated: boolean, out?: DashboardOut, why?: "refused"): void;
  /** Asked before replacing: true when a draft or edit session exists now (the dialog then closes and the page says so). */
  refuse?(): boolean;
  /** Where the keyboard goes when the dialog closes (More actions). */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export function UpdateFromSourceDialog({ dashboard, origin, onClose, refuse, restoreFocusTo }: UpdateFromSourceDialogProps) {
  const id = useId();
  const client = useQueryClient();
  const asks = needsInput(origin);
  const projects = useProjects();
  const project = dashboard.owner_kind === "project" ? projects.data?.find((p) => p.id === dashboard.owner_id) ?? null : null;

  // What the source is (a file's text or pasted text; none for a connected Grafana).
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [paste, setPaste] = useState("");
  const input: TextInput | null = !asks ? null
    : fileText !== null && file ? { kind: "text", text: fileText, file_name: file.name, via: "file" }
    : paste.trim() !== "" ? { kind: "text", text: paste, via: "paste" } : null;

  // The review and the choices made in it.
  const [preview, setPreview] = useState<UpdatePreviewOut | null>(null);
  const [mapping, setMapping] = useState<Record<string, MappingIn>>({});
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  /** Counts failed checks: each one makes sure the keyboard is still in the dialog. */
  const [failures, setFailures] = useState(0);
  /** Why the review ran again (the source or the dashboard changed since it was shown). */
  const [notice, setNotice] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const fileButton = useRef<HTMLButtonElement>(null);
  const pasteArea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tryAgainRef = useRef<HTMLButtonElement>(null);
  const first = asks ? (origin.via === "paste" ? pasteArea : fileButton) : cancelRef;

  const inflight = useRef<AbortController | null>(null);
  /** The next review takes the keyboard (Replace with the source, or Close); not after a source pick. */
  const focusResult = useRef(false);
  useEffect(() => () => inflight.current?.abort(), []);

  const mappingList = (m: Record<string, MappingIn>) => Object.values(m);

  /** Reads the source and makes the review; the last one asked wins. */
  const check = async (withInput: TextInput | null, withMapping: Record<string, MappingIn>, takeFocus: boolean) => {
    if (asks && !withInput) return;
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    focusResult.current = takeFocus;
    setChecking(true);
    // A failure's words (and its Try again, which may have the keyboard) stay until the answer.
    const list = mappingList(withMapping);
    const body: UpdatePreviewIn = { ...(withInput ? { input: withInput } : {}), ...(list.length ? { mapping: list } : {}) };
    try {
      const out = await previewUpdate(dashboard.id, body, ctl.signal);
      if (ctl.signal.aborted) return;
      setCheckError(null);
      setPreview(out);
    } catch (err) {
      if (ctl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      // Never a review of something else as if it were this one.
      setPreview(null);
      setCheckError(failure(err, "check again"));
      setFailures((n) => n + 1);
    } finally {
      if (inflight.current === ctl) {
        inflight.current = null;
        setChecking(false);
      }
    }
  };

  // A connected Grafana is read at once.
  useEffect(() => {
    if (!asks) void check(null, {}, true);
    // Once, as the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The review is shown: the keyboard goes to its action (Close when nothing changed).
  useLayoutEffect(() => {
    if (!preview || !focusResult.current) return;
    focusResult.current = false;
    (preview.same ? closeRef : replaceRef).current?.focus();
  }, [preview]);

  // A failed check removed the review, and with it what had the keyboard (a source's select): the
  // keyboard goes to Try again, Check or Cancel, never <body>.
  useLayoutEffect(() => {
    if (failures === 0) return;
    const a = document.activeElement;
    if (a === null || a === document.body || !a.isConnected) (tryAgainRef.current ?? checkRef.current ?? cancelRef.current)?.focus();
  }, [failures]);

  // A new source makes the review out of date: it goes until Check runs again.
  const sourceChanged = () => {
    inflight.current?.abort();
    inflight.current = null;
    setChecking(false);
    setPreview(null);
    setNotice(null);
    setApplyError(null);
    setCheckError(null);
  };
  const pickFile = async (f: File) => {
    sourceChanged();
    setFileError(null);
    if (f.size > MAX_FILE_BYTES) {
      setFile(null);
      setFileText(null);
      setFileError(TOO_BIG);
      return;
    }
    setReading(true);
    try {
      const text = await f.text();
      setFile({ name: f.name, size: f.size });
      setFileText(text);
      setPaste("");
    } catch {
      setFile(null);
      setFileText(null);
      setFileError(UNREADABLE);
    } finally {
      setReading(false);
    }
  };
  const typed = (text: string) => {
    sourceChanged();
    setPaste(text);
    if (text.trim() !== "") {
      setFile(null);
      setFileText(null);
      setFileError(null);
    }
  };
  const runCheck = () => {
    if (checking || reading || !input) return;
    void check(input, mapping, true);
  };
  const changeMapping = (key: string, m: MappingIn) => {
    const next = { ...mapping, [key]: m };
    setMapping(next);
    setNotice(null);
    setApplyError(null);
    void check(input, next, false);
  };

  const replace = async () => {
    if (!preview || preview.same || checking || applying) return;
    if (refuse?.()) {
      onClose(false, undefined, "refused");
      return;
    }
    setApplying(true);
    setApplyError(null);
    setNotice(null);
    const list = mappingList(mapping);
    const body: UpdateApplyIn = {
      base_version: preview.current_version, digest: preview.digest,
      ...(input ? { input } : {}), ...(list.length ? { mapping: list } : {}),
    };
    let out: DashboardOut;
    try {
      // A plain call: the body can hold a file's text.
      out = await applyUpdate(dashboard.id, body);
    } catch (err) {
      setApplying(false);
      const code = err instanceof TransferRequestError ? err.code : null;
      if (code === "source_changed" || code === "changed" || code === "version_conflict") {
        // What was reviewed is no longer what would be written: the review runs again, with words.
        setNotice(code === "version_conflict" ? SAVED_ELSEWHERE : SOURCE_CHANGED);
        if (code === "version_conflict") void client.invalidateQueries({ queryKey: dashboardKey(dashboard.id), exact: true });
        void check(input, mapping, true);
      } else {
        setApplyError(failure(err, "try again"));
        replaceRef.current?.focus();
      }
      return;
    }
    client.setQueryData(dashboardKey(out.id), out);
    void invalidateMonitoring(client);
    onClose(true, out);
  };

  const onConfirm = () => {
    if (preview && !preview.same) void replace();
    else if (!preview && asks) runCheck();
  };
  const cancel = () => { if (!applying) onClose(false); };

  const onPasteKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc in the text goes to Check first (a second Esc closes), like the Import page.
    if (e.key === "Escape" && !e.defaultPrevented && paste !== "") {
      e.preventDefault();
      e.stopPropagation();
      checkRef.current?.focus();
    }
  };

  const label = preview?.source_label ?? origin.label;
  const skipped = preview?.skipped ?? [];
  const waiting = checking && !preview;

  return (
    <DialogShell provider="monitoring" role="dialog" busy={applying} onCancel={cancel} onConfirm={onConfirm} first={first}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} describedBy={`${id}-from`} className={x.dialog}>
      <header className={x.head}>
        <h2 id={`${id}-t`} className={x.title}>Update "{dashboard.title}" from its source</h2>
        <p id={`${id}-from`} className={x.from}>
          <svg viewBox="0 0 16 16" aria-hidden="true" className={x.fromIcon}><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.5h10" /></svg>
          {fromWords(label, origin.kind, preview)}
        </p>
      </header>

      <div className={x.body} aria-busy={checking || undefined}>
        {asks && (
          <div className={x.collect}>
            <div className={x.collectRow}>
              <input ref={fileInput} type="file" accept=".json,application/json" className={x.fileInput} tabIndex={-1} aria-hidden="true"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = ""; }} />
              <button ref={fileButton} type="button" className={x.secondary} onClick={() => fileInput.current?.click()}>Pick the file again</button>
              {reading && <span className={x.fileName} role="status">Reading…</span>}
              {file && !reading && <span className={x.fileName}>{`${file.name} · ${sizeWords(file.size)}`}</span>}
            </div>
            {fileError && <p className={x.error} role="alert">{fileError}</p>}
            <label className={x.pasteLabel} htmlFor={`${id}-paste`}>or paste its JSON</label>
            <textarea ref={pasteArea} id={`${id}-paste`} className={x.paste} spellCheck={false} autoComplete="off"
              aria-keyshortcuts="Control+Enter" value={paste} onChange={(e) => typed(e.target.value)} onKeyDown={onPasteKey} />
            <div className={x.checkRow}>
              <button ref={checkRef} type="button" className={x.primary} aria-disabled={!input || checking || reading || undefined}
                aria-busy={checking || undefined} onClick={runCheck}>
                {checking ? "Checking…" : "Check"}
              </button>
            </div>
          </div>
        )}

        {waiting && !asks && <p className={x.note} role="status">Reading the source…</p>}
        {checkError && (
          <div className={x.problem} role="alert">
            <p className={x.problemLine}>{checkError}</p>
            {!asks && (
              <button ref={tryAgainRef} type="button" className={x.secondary} aria-disabled={checking || undefined} aria-busy={checking || undefined}
                onClick={() => { if (!checking) void check(null, mapping, true); }}>
                {checking ? "Trying again…" : "Try again"}
              </button>
            )}
          </div>
        )}
        {notice && <p className={x.notice} role="alert">{notice}</p>}

        {preview && preview.same && <p className={x.same} role="status">{NOTHING_CHANGED}</p>}
        {preview && !preview.same && (
          <div className={x.review} data-stale={checking || undefined}>
            {preview.identity_warning && <p className={x.warn}>{preview.identity_warning}</p>}
            {preview.edited_since_import && <p className={x.warn}>{EDITED_SINCE_IMPORT}</p>}
            {preview.title_note && <p className={x.line}>{preview.title_note}</p>}
            {preview.new_sources.length > 0 && (
              <section className={x.block} aria-labelledby={`${id}-sources`}>
                <h3 id={`${id}-sources`} className={x.blockTitle}>New data sources</h3>
                <SourceMappingTable refs={preview.new_sources} project={project} ownerKind={dashboard.owner_kind} value={mapping} onChange={changeMapping} />
              </section>
            )}
            <JsonDiff before={dashboardJson(asSpec(preview.current))} after={dashboardJson(asSpec(preview.incoming))}
              beforeLabel={`Now (version ${preview.current_version})`} afterLabel="From the source" />
            {skipped.length > 0 && (
              <section className={x.block} aria-labelledby={`${id}-skipped`}>
                <h3 id={`${id}-skipped`} className={x.blockTitle}>Skipped ({skipped.length})</h3>
                <SkippedList items={skipped} />
              </section>
            )}
          </div>
        )}
        {applyError && <p className={x.error} role="alert">{applyError}</p>}
      </div>

      <div className={x.actions}>
        {preview?.same ? (
          <button ref={closeRef} type="button" className={x.primary} onClick={() => onClose(false)}>Close</button>
        ) : (
          <>
            <button ref={cancelRef} type="button" className={x.secondary} aria-disabled={applying || undefined} onClick={cancel}>Cancel</button>
            {preview && (
              <button ref={replaceRef} type="button" className={x.primary} aria-disabled={checking || applying || undefined}
                aria-busy={applying || undefined} aria-keyshortcuts="Control+Enter" onClick={() => void replace()}>
                {applying ? "Replacing…" : "Replace with the source"}
              </button>
            )}
          </>
        )}
      </div>
    </DialogShell>
  );
}
