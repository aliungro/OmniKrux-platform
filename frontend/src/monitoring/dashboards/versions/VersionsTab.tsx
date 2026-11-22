// The Versions tab of a saved dashboard (never a ready-made view: those have no versions, and
// their ids answer 404 here). Newest first, each with when it was saved, its panels and where it
// came from. Pick two to compare (older on the left), compare one with the current version, or
// restore one: that saves a new version, and nothing is deleted.
import { useRef, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { getVersion, useVersions, versionsKey, type DashboardOut, type DashboardRequestError, type VersionDetailOut, type VersionOut } from "../api";
import { draftTime } from "../drafts/DraftBanner";
import { JsonDiff } from "../JsonDiff";
import { dashboardJson } from "../schema";
import { RestoreDialog } from "./RestoreDialog";
import s from "./VersionsTab.module.css";

export const RESTORE_REFUSED = "Save or discard your draft before restoring a version.";

const origin = (v: VersionOut): string => {
  switch (v.origin) {
    case "created": return "Created";
    case "copied": return v.copied_from ? `Copied from ${v.copied_from}` : "Copied";
    case "saved": return "Saved";
    case "restored": return v.restored_from !== null ? `Restored from version ${v.restored_from}` : "Restored";
  }
};
const panelsText = (n: number) => (n === 1 ? "1 panel" : `${n} panels`);
const savedTime = (iso: string) => { const ms = Date.parse(iso); return Number.isNaN(ms) ? iso : draftTime(ms); };

/** One version's document; the current one is the dashboard's own. */
function useVersionDoc(dashboard: DashboardOut, n: number) {
  const current = n === dashboard.version;
  const q = useQuery<VersionDetailOut, DashboardRequestError>({
    queryKey: [...versionsKey(dashboard.id), n],
    queryFn: () => getVersion(dashboard.id, n),
    enabled: !current,
    staleTime: Infinity,
    retry: false,
  });
  return current ? { spec: dashboard.spec, error: null, retry: () => {} } : { spec: q.data?.spec ?? null, error: q.error, retry: () => void q.refetch() };
}

function Comparison({ dashboard, a, b, onClose }: { dashboard: DashboardOut; a: number; b: number; onClose(): void }) {
  const older = useVersionDoc(dashboard, a);
  const newer = useVersionDoc(dashboard, b);
  const failed = older.error ?? newer.error;
  return (
    <section className={s.compare} aria-label={`Version ${a} and version ${b}`}>
      {failed ? (
        <div className={s.compareProblem} role="alert">
          <p className={s.problemLine}>{failure(failed, "try again")}</p>
          <button type="button" className={s.btn} onClick={() => { older.retry(); newer.retry(); }}>Try again</button>
        </div>
      ) : older.spec && newer.spec ? (
        <JsonDiff before={dashboardJson(older.spec)} after={dashboardJson(newer.spec)} beforeLabel={`Version ${a}`} afterLabel={`Version ${b}`} />
      ) : (
        <p className={s.note} role="status">Loading the versions…</p>
      )}
      <div className={s.compareBar}>
        <button type="button" className={s.btn} onClick={onClose}>Close comparison</button>
      </div>
    </section>
  );
}

export function VersionsTab({ dashboard, restoreBlocked, onRestored }: {
  dashboard: DashboardOut;
  /** Whether a draft or an edit session exists for this dashboard (restoring would overwrite under it). */
  restoreBlocked(): boolean;
  /** After a restore: the page shows the Dashboard tab with the new version. */
  onRestored(out: DashboardOut): void;
}) {
  const versions = useVersions(dashboard.id);
  const [picked, setPicked] = useState<number[]>([]);
  const [comparing, setComparing] = useState<{ a: number; b: number } | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [refused, setRefused] = useState<number | null>(null);
  const compareButton = useRef<HTMLButtonElement>(null);
  /** What opened the comparison or the restore dialog: the keyboard goes back there. */
  const compareOpener = useRef<HTMLButtonElement | null>(null);
  const restoreOpener = useRef<HTMLButtonElement | null>(null);

  // At most two picks: a third lets go of the earliest.
  const toggle = (n: number) => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : p.length >= 2 ? [p[p.length - 1], n] : [...p, n]));
  const two = picked.length === 2;
  const compare = () => {
    if (!two) return;
    compareOpener.current = compareButton.current;
    setComparing({ a: Math.min(...picked), b: Math.max(...picked) });
  };
  const compareWithCurrent = (n: number, e: MouseEvent<HTMLButtonElement>) => {
    compareOpener.current = e.currentTarget;
    setComparing({ a: Math.min(n, dashboard.version), b: Math.max(n, dashboard.version) });
  };
  const closeComparison = () => {
    setComparing(null);
    const back = compareOpener.current;
    (back?.isConnected ? back : compareButton.current)?.focus();
  };
  const askRestore = (n: number, e: MouseEvent<HTMLButtonElement>) => {
    restoreOpener.current = e.currentTarget;
    if (restoreBlocked()) {
      setRefused(n);
      return;
    }
    setRefused(null);
    setRestoring(n);
  };

  if (versions.isPending) return <p className={s.note} role="status">Loading versions…</p>;
  if (versions.isError) {
    return (
      <div className={s.compareProblem} role="alert">
        <p className={s.problemLine}>{failure(versions.error, "try again")}</p>
        <button type="button" className={s.btn} onClick={() => void versions.refetch()}>Try again</button>
      </div>
    );
  }

  return (
    <div className={s.tab}>
      <div className={s.toolbar}>
        <p className={s.hint}>{picked.length === 0 ? "Pick two versions to compare them." : picked.length === 1 ? "Pick one more version to compare." : `Version ${Math.min(...picked)} and version ${Math.max(...picked)} picked.`}</p>
        <button ref={compareButton} type="button" className={`${s.btn} ${s.go}`} aria-disabled={!two || undefined} onClick={compare}>Compare</button>
      </div>
      {comparing && <Comparison key={`${comparing.a}-${comparing.b}`} dashboard={dashboard} a={comparing.a} b={comparing.b} onClose={closeComparison} />}
      <ul className={s.list} aria-label="Versions">
        {versions.data.map((v) => {
          const current = v.version === dashboard.version;
          return (
            <li key={v.version} className={s.row} data-current={current || undefined} data-picked={picked.includes(v.version) || undefined}>
              <input type="checkbox" className={s.pick} aria-label={`Pick version ${v.version} to compare`}
                checked={picked.includes(v.version)} onChange={() => toggle(v.version)} />
              <span className={s.node} aria-hidden="true" />
              <div className={s.what}>
                <div className={s.nameLine}>
                  <h2 className={s.name}>Version {v.version}</h2>
                  {current && <span className={s.current}>Current</span>}
                </div>
                <p className={s.meta}>
                  <time dateTime={v.saved_at}>{savedTime(v.saved_at)}</time> · {panelsText(v.panel_count)} · {origin(v)}
                </p>
              </div>
              {!current && (
                <div className={s.actions}>
                  <button type="button" className={s.btn} onClick={(e) => compareWithCurrent(v.version, e)}>Compare with current</button>
                  <button type="button" className={s.btn} onClick={(e) => askRestore(v.version, e)}>Restore…</button>
                </div>
              )}
              {refused === v.version && <p className={s.refused} role="alert">{RESTORE_REFUSED}</p>}
            </li>
          );
        })}
      </ul>
      {restoring !== null && (
        <RestoreDialog dashboardId={dashboard.id} version={restoring} baseVersion={dashboard.version} restoreFocusTo={restoreOpener}
          onCancel={() => setRestoring(null)}
          onRestored={(out) => { setRestoring(null); onRestored(out); }} />
      )}
    </div>
  );
}
