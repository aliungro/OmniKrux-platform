// Setup step 3: copy dashboards from the Grafana discovery found in the cluster. Its dashboards load
// through a plain call (a connection reached by its address carries a token, which never becomes a
// query key, a cache entry, a URL or text on the page); every one starts chosen (at most 100). The
// page previews the chosen ones once the choice settles and shows here what converts. A Grafana
// that wants a sign-in can be reached by its address instead, or the import skipped. Nothing is
// saved here: the import runs after the project is created.
import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { FoundTool } from "../api/types";
import type { GrafanaIn, ImportPreviewOut } from "../transfer/api";
import { newGrafanaDashboards, TransferRequestError } from "../transfer/api";
import { GrafanaDashboardList } from "../transfer/GrafanaDashboardList";
import { GrafanaForm } from "../transfer/GrafanaForm";
import { dashboardsWord } from "../transfer/grafanaLabels";
import { notImportableWords } from "../transfer/importModel";
import { SkippedList } from "../transfer/SkippedList";
import { plainUrl } from "./setupDraftStore";
import { foundDetail, importable, importSkipped, type SetupImport } from "./setupModel";
import s from "./SetupPage.module.css";
import i from "./ImportStep.module.css";

export const CHECKING = "Checking what converts…";
// Setup maps nothing by address: every data source reads the project's first source of its type.
export const FIRST_SOURCE = "Each Grafana data source goes to the first source of its type in this project.";
export const SIGN_IN_AGAIN = "Its sign-in wasn't kept. Enter it again to load its dashboards.";

/** The tail of the backend's `SIGN_IN_CLUSTER` refusal (`{name} needs a sign-in, …`), word for word. */
const SIGN_IN_CLUSTER = " needs a sign-in, and a Grafana reached through its cluster can't take one. Reach it by its address instead, with a service account token.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What won't be copied: `2 things won't be copied`, or `everything converts`. */
export const skippedWords = (k: number): string => (k === 0 ? "everything converts" : `${plural(k, "thing", "things")} won't be copied`);

/** `3 dashboards to copy · 2 things won't be copied`, or `· everything converts`. */
export const copyWords = (n: number, k: number): string => `${dashboardsWord(n)} to copy · ${skippedWords(k)}`;

/** A preview on its way, or one that failed (the page runs it). */
export type ImportCheck = { state: "idle" } | { state: "checking" } | { state: "failed"; message: string };

export interface ImportStepProps {
  /** The step's heading (the page draws it): the keyboard's fallback. */
  heading: RefObject<HTMLHeadingElement | null>;
  clusterName: string;
  /** The Grafana discovery found (its row's details). */
  tool: FoundTool | undefined;
  imp: SetupImport;
  /** Changes with every new connection: the list loads again. */
  connectionRev: number;
  /** Every dashboard starts chosen (a first load of this connection). */
  defaultAll: boolean;
  check: ImportCheck;
  onUids(uids: string[]): void;
  onConnection(connection: GrafanaIn): void;
  onCheckAgain(): void;
  onSkip(): void;
}

/**
 * What a preview says will be copied: the count and what won't be copied, each dashboard with its
 * **Skipped (k)** list or why it can't be imported, and how its data sources are read. Shown before
 * anything is saved, here and on the retry after setup.
 */
export function PreviewLedger({ preview: p }: { preview: ImportPreviewOut }) {
  const ids = useId();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      <p className={i.summary} aria-live="polite">{copyWords(importable(p).length, importSkipped(p))}</p>
      <ul className={i.dashboards} aria-label="Dashboards to copy">
        {p.dashboards.map((d) => {
          const k = d.skipped.length;
          const base = `${ids}-${d.key}`;
          return (
            <li key={d.key} className={i.dashboard} data-off={!d.importable || undefined}>
              <span className={i.dashboardTitle}>{d.title}</span>
              {!d.importable && <span className={i.cant}>{notImportableWords(d)}</span>}
              {d.importable && k > 0 && (
                <button type="button" className={i.skippedButton} aria-expanded={!!open[d.key]}
                  aria-controls={open[d.key] ? `${base}-s` : undefined}
                  onClick={() => setOpen((o) => ({ ...o, [d.key]: !o[d.key] }))}>
                  Skipped ({k})
                </button>
              )}
              {d.importable && k > 0 && open[d.key] && <div id={`${base}-s`} className={i.skipped}><SkippedList items={d.skipped} /></div>}
            </li>
          );
        })}
      </ul>
      <p className={i.mapping}>{FIRST_SOURCE}</p>
    </>
  );
}

function isSignIn(err: unknown): err is TransferRequestError {
  return err instanceof TransferRequestError && err.code === "grafana" && err.message.endsWith(SIGN_IN_CLUSTER);
}

export function ImportStep({ heading, clusterName, tool, imp, connectionRev, defaultAll, check, onUids, onConnection, onCheckAgain, onSkip }: ImportStepProps) {
  const panel = useRef<HTMLDivElement>(null);
  /** "Use its address instead", or "Enter it again": the button that opens the form. */
  const useAddress = useRef<HTMLButtonElement>(null);
  /** The Grafana's own words when it asked for a sign-in, for the connection it was asked with. */
  const [signIn, setSignIn] = useState<{ rev: number; message: string } | null>(null);
  // Restored without its secret, the form for it opens at once.
  const [form, setForm] = useState(imp.secretsDropped === true);
  const asking = signIn !== null && signIn.rev === connectionRev ? signIn.message : null;
  const enterAgain = imp.secretsDropped === true;

  const connection = imp.connection;
  const load = useCallback(() => newGrafanaDashboards(connection).catch((err: unknown) => {
    if (isSignIn(err) && connection.reach === "cluster") setSignIn({ rev: connectionRev, message: err.message });
    throw err;
  }), [connection, connectionRev]);
  const selected = new Set(imp.uids);

  // The list that had the keyboard is gone: it goes to "Use its address instead", never to <body>.
  useLayoutEffect(() => {
    if (!asking) return;
    const active = document.activeElement;
    if (active === null || active === document.body || panel.current?.contains(active) || !active.isConnected) useAddress.current?.focus();
  }, [asking]);

  const collect = (body: GrafanaIn) => {
    setForm(false);
    setSignIn(null);
    onConnection(body);
  };
  // Closed without a connection: back to the choice that opened it (for a restored one, its note
  // with "Enter it again" and "Skip import"); the import is never skipped by Esc.
  const closeForm = () => setForm(false);
  // Back from the form: the keyboard returns to the button that opened it.
  const formWasOpen = useRef(false);
  useLayoutEffect(() => {
    if (formWasOpen.current && !form) (useAddress.current ?? heading.current)?.focus();
    formWasOpen.current = form;
  }, [form, heading]);

  // An address is shown without a sign-in, a query or a fragment in it.
  const where = connection.reach === "url" ? plainUrl(connection.url ?? "") : tool ? foundDetail(tool) : `${connection.namespace ?? ""}/${connection.service ?? ""}`;
  const p = imp.preview;
  const choice = (words: string, label: string) => (
    <div className={i.signIn}>
      <p role="alert" className={i.signInWords}>{words}</p>
      <div className={i.actions}>
        <button ref={useAddress} type="button" className={s.secondary} onClick={() => setForm(true)}>{label}</button>
        <button type="button" className={s.quiet} onClick={onSkip}>Skip import</button>
      </div>
    </div>
  );

  return (
    <>
      <p className={s.lead}>OmniKrux found Grafana in {clusterName}. Copy its dashboards into this project. Nothing in Grafana changes.</p>

      <div ref={panel} className={i.panel}>
        <div role="group" aria-label="Grafana" className={i.source}>
          <span className={s.badge} data-type="grafana" aria-hidden="true">G</span>
          <div className={s.what}>
            <span className={s.toolName}>Grafana</span>
            <span className={s.detail}>{where}</span>
          </div>
        </div>

        {form ? (
          <div className={i.form}>
            {enterAgain && <p className={i.note}>{SIGN_IN_AGAIN}</p>}
            <GrafanaForm mode="collect" closeOnEscape preset={enterAgain ? connection : { name: connection.name, reach: "url" }}
              onCollect={collect} onCancel={closeForm} />
          </div>
        ) : enterAgain ? choice(SIGN_IN_AGAIN, "Enter it again")
          : asking ? choice(asking, "Use its address instead")
          : (
          <GrafanaDashboardList load={load} loadKey={String(connectionRev)} selected={selected} defaultAll={defaultAll}
            name="Grafana" onChange={(next) => onUids([...next])} />
        )}

        {!form && !enterAgain && !asking && imp.uids.length > 0 && (
          <div className={i.check}>
            {check.state === "checking" && <p className={i.checking} role="status">{CHECKING}</p>}
            {check.state === "failed" && (
              <div className={i.failed} role="alert">
                <p>{check.message}</p>
                <button type="button" className={s.secondary} onClick={onCheckAgain}>Check again</button>
              </div>
            )}
            {check.state === "idle" && p && <PreviewLedger preview={p} />}
          </div>
        )}
      </div>
    </>
  );
}
