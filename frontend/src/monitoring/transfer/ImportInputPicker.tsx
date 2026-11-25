// What to import from: a file (chosen or dropped; read in the browser, never stored), pasted JSON,
// or dashboards of a Grafana (a saved connection, or one connected here). The three choices are
// one radio group: one Tab stop, ↑/↓ (and ←/→) move and pick.
import { useEffect, useId, useRef, type DragEvent, type KeyboardEvent, type RefObject } from "react";
import { grafanaDashboards, useGrafanaConnections, type GrafanaOut } from "./api";
import { GrafanaDashboardList } from "./GrafanaDashboardList";
import { GrafanaForm } from "./GrafanaForm";
import { grafanaWhere } from "./grafanaLabels";
import { sizeWords } from "./importModel";
import s from "./ImportPage.module.css";

export type InputMode = "file" | "paste" | "grafana";

/** The select's value while a new connection is being made. */
export const CONNECTING = "__connect";

const MODES: { mode: InputMode; title: string; sub: string }[] = [
  { mode: "file", title: "A file", sub: "An OmniKrux export or a Grafana dashboard, as .json" },
  { mode: "paste", title: "Pasted JSON", sub: "A Grafana dashboard's JSON model, or an OmniKrux export" },
  { mode: "grafana", title: "A Grafana", sub: "Pick dashboards from a Grafana you connect" },
];

export interface ImportInputPickerProps {
  tabId: string;
  mode: InputMode;
  onMode(mode: InputMode): void;
  file: { name: string; size: number } | null;
  fileError: string | null;
  reading: boolean;
  onFile(file: File): void;
  paste: string;
  onPaste(text: string): void;
  /** A saved connection's id, CONNECTING, or "" before one is picked. */
  grafanaId: string;
  onGrafana(id: string): void;
  uids: ReadonlySet<string>;
  onUids(next: Set<string>): void;
  canCheck: boolean;
  checking: boolean;
  error: string | null;
  onCheck(): void;
  checkRef: RefObject<HTMLButtonElement | null>;
}

export function ImportInputPicker(p: ImportInputPickerProps) {
  const ids = useId();
  const radios = useRef(new Map<InputMode, HTMLInputElement>());
  const fileInput = useRef<HTMLInputElement>(null);
  const grafanaSelect = useRef<HTMLSelectElement>(null);
  const connections = useGrafanaConnections();
  const list = connections.data ?? [];
  const chosen: GrafanaOut | undefined = list.find((g) => g.id === p.grafanaId);
  // In Grafana mode, the first saved connection is picked until another is (never while a file or
  // pasted JSON is being checked: that would close its review).
  const first = list[0]?.id;
  const { grafanaId, onGrafana, mode } = p;
  useEffect(() => { if (mode === "grafana" && grafanaId === "" && first) onGrafana(first); }, [mode, grafanaId, first, onGrafana]);

  const onRadioKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const at = MODES.findIndex((m) => m.mode === p.mode);
    const next = MODES[(at + step + MODES.length) % MODES.length].mode;
    p.onMode(next);
    radios.current.get(next)?.focus();
  };

  const onPasteKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      p.onCheck();
    } else if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      p.checkRef.current?.focus();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) p.onFile(f);
  };

  const backToSelect = () => setTimeout(() => grafanaSelect.current?.focus(), 0);

  return (
    <div className={s.picker}>
      <div role="radiogroup" aria-labelledby={`${ids}-from`} className={s.modes} onKeyDown={onRadioKey}>
        <span id={`${ids}-from`} className={s.label}>Import from</span>
        {MODES.map((m) => (
          <label key={m.mode} className={s.mode} data-checked={p.mode === m.mode || undefined}>
            {/* One group: one Tab stop, the arrow keys move between the choices and pick. */}
            <input ref={(el) => { if (el) radios.current.set(m.mode, el); else radios.current.delete(m.mode); }}
              type="radio" name={`${ids}-from`} className={s.radio} checked={p.mode === m.mode} aria-labelledby={`${ids}-${m.mode}-t`} aria-describedby={`${ids}-${m.mode}`}
              onChange={() => p.onMode(m.mode)} />
            <span className={s.modeText}>
              <span id={`${ids}-${m.mode}-t`} className={s.modeTitle}>{m.title}</span>
              <span id={`${ids}-${m.mode}`} className={s.modeSub}>{m.sub}</span>
            </span>
          </label>
        ))}
      </div>

      {p.mode === "file" && (
        <div className={s.drop} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <input ref={fileInput} type="file" accept=".json,application/json" className={s.fileInput} tabIndex={-1} aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onFile(f); e.target.value = ""; }} />
          <button type="button" className={s.secondary} onClick={() => fileInput.current?.click()}>Choose a file</button>
          <span className={s.dropText}>or drop a .json file here</span>
          {p.reading && <span className={s.fileName} role="status">Reading…</span>}
          {p.file && !p.reading && <span className={s.fileName}>{`${p.file.name} · ${sizeWords(p.file.size)}`}</span>}
          {p.fileError && <p className={s.error} role="alert">{p.fileError}</p>}
        </div>
      )}

      {p.mode === "paste" && (
        <textarea className={s.paste} aria-label="JSON to import" placeholder="Paste JSON here" spellCheck={false} autoComplete="off"
          aria-keyshortcuts="Control+Enter" value={p.paste} onChange={(e) => p.onPaste(e.target.value)} onKeyDown={onPasteKey} />
      )}

      {p.mode === "grafana" && (
        <div className={s.grafana}>
          <select ref={grafanaSelect} className={s.select} aria-label="Grafana" value={p.grafanaId}
            onChange={(e) => p.onGrafana(e.target.value)}>
            {p.grafanaId === "" && <option value="" disabled>{connections.isPending ? "Loading Grafana connections…" : "No Grafana connected"}</option>}
            {list.map((g) => <option key={g.id} value={g.id}>{`${g.name} · ${grafanaWhere(g)}`}</option>)}
            <option value={CONNECTING}>Connect a Grafana…</option>
          </select>
          {p.grafanaId === CONNECTING && (
            <div className={s.connect}>
              <GrafanaForm mode="save" closeOnEscape leave={{ tabId: p.tabId, page: "import", title: "Connect a Grafana" }}
                onSaved={(g) => { p.onGrafana(g.id); backToSelect(); }}
                onCancel={() => { p.onGrafana(list[0]?.id ?? ""); backToSelect(); }} />
            </div>
          )}
          {chosen && (
            <GrafanaDashboardList load={() => grafanaDashboards(chosen.id)} loadKey={chosen.id} selected={p.uids} onChange={p.onUids} name={chosen.name} />
          )}
        </div>
      )}

      <div className={s.checkRow}>
        <button ref={p.checkRef} type="button" className={s.primary} aria-disabled={!p.canCheck || p.checking || undefined} onClick={p.onCheck}>
          {p.checking ? "Checking…" : "Check what converts"}
        </button>
      </div>
      {p.error && <p className={s.error} role="alert">{p.error}</p>}
    </div>
  );
}
