// Exporting a dashboard, a project or a group: the server builds the file (never a password or a
// token in it), the browser saves it as `ExportOut.file_name`, and a line says what was exported.
// `useExport` is the request and its words; `ExportLine` says them; `ExportButton` is both, for the
// project and group pages. The dashboard page's More actions uses the hook and the line directly.
import { useState, type MouseEvent } from "react";
import { failure } from "../../api/http";
import { useExportItem, type ExportKind, type ExportOut } from "./api";
import { saveJsonFile } from "./download";
import x from "./Export.module.css";

export const NO_SECRETS_IN_EXPORTS = "Passwords and tokens are never in exports.";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What an export says once its file is saved. */
export function exportedWords(kind: ExportKind, name: string, out: Pick<ExportOut, "dashboards" | "sources">): string {
  if (kind === "dashboard") return `Exported "${name}". ${NO_SECRETS_IN_EXPORTS}`;
  if (kind === "group") return `Exported ${name}: ${count(out.dashboards, "dashboard", "dashboards")}.`;
  return `Exported ${name}: ${count(out.dashboards, "dashboard", "dashboards")} and ${count(out.sources, "source", "sources")}. ${NO_SECRETS_IN_EXPORTS}`;
}

export type ExportResult = { ok: true; text: string } | { ok: false; text: string };

export interface Exporter {
  busy: boolean;
  result: ExportResult | null;
  /** Exports `kind` `id` (named `name` in the words) and saves the file. */
  run(kind: ExportKind, id: string, name: string): void;
}

export function useExport(): Exporter {
  const mutation = useExportItem();
  const [result, setResult] = useState<ExportResult | null>(null);
  const busy = mutation.isPending;
  const run = (kind: ExportKind, id: string, name: string) => {
    if (busy) return;
    setResult(null);
    mutation.mutate({ kind, id }, {
      onSuccess: (out) => {
        saveJsonFile(out.file_name, out.export);
        setResult({ ok: true, text: exportedWords(kind, name, out) });
      },
      onError: (err) => setResult({ ok: false, text: failure(err, "try again") }),
    });
  };
  return { busy, result, run };
}

/**
 * What the last export said. The status line is always there (so it is announced when it fills);
 * a failure is an alert. `wide`: on a row of its own under the controls it sits in.
 */
export function ExportLine({ result, wide = false }: { result: ExportResult | null; wide?: boolean }) {
  return (
    <>
      <p className={x.done} data-wide={wide || undefined} role="status">{result?.ok ? result.text : ""}</p>
      {result && !result.ok && <p className={x.failed} data-wide={wide || undefined} role="alert">{result.text}</p>}
    </>
  );
}

/** Import dashboards… beside a page's Export: opens Import for that page's project or group (Ctrl+click: a new tab). */
export function ImportButton({ onOpen }: { onOpen(e: MouseEvent<HTMLButtonElement>): void }) {
  return (
    <button type="button" className={x.button} onClick={onOpen}>
      <svg viewBox="0 0 16 16" aria-hidden="true" className={x.icon}><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.5h10" /></svg>
      Import dashboards…
    </button>
  );
}

/**
 * An Export button and its line, for a page's heading row (`Export project`, `Export group`). The
 * line wraps onto its own row under the heading row it sits in.
 */
export function ExportButton({ kind, id, label, name }: { kind: ExportKind; id: string; label: string; name: string }) {
  const exporter = useExport();
  return (
    <>
      <button type="button" className={x.button} aria-disabled={exporter.busy || undefined} aria-busy={exporter.busy || undefined}
        onClick={() => exporter.run(kind, id, name)}>
        <svg viewBox="0 0 16 16" aria-hidden="true" className={x.icon}><path d="M8 10.25V2.75M4.75 6 8 2.75 11.25 6M3 13.5h10" /></svg>
        {exporter.busy ? "Exporting…" : label}
      </button>
      <ExportLine result={exporter.result} wide />
    </>
  );
}
