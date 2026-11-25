// The Dashboards section of a project or group page: New dashboard, the owner's saved dashboards
// (title, panels, when saved), and for a project its ready-made views with Copy to edit.
import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { failure } from "../../api/http";
import type { MonitoringPageProps } from "../MonitoringApp";
import type { MonitoringView } from "../shell/tabState";
import { useOwnerDashboards, useReadyMade, type DashboardSummaryOut } from "./api";
import { openMade, useCopyToEdit, type Opener } from "./create/arrival";
import type { Owner } from "./create/currentOwner";
import { NewDashboardDialog } from "./create/NewDashboardDialog";
import s from "./OwnerDashboards.module.css";

const EMPTY = {
  project: "No dashboards yet. Start one with New dashboard, or copy a ready-made view.",
  group: "No group dashboards yet. A group dashboard runs each panel once per project in the group.",
} as const;
const CANT_CHECK = "Can't be checked now.";
const NO_READY = "Link a Prometheus-compatible or Loki source to get ready-made views.";

/** "saved just now", "saved 5 min ago", "saved 3 h ago", "saved 2 days ago", then the date. */
export function savedAgo(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "saved just now";
  if (minutes < 60) return `saved ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `saved ${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `saved ${days} ${days === 1 ? "day" : "days"} ago`;
  return `saved on ${new Date(at).toISOString().slice(0, 10)}`;
}

const panels = (n: number) => (n === 1 ? "1 panel" : `${n} panels`);
const toNewTab = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/** A small grid mark: the dashboard's own glyph in lists. */
function GridMark() {
  return (
    <svg className={s.mark} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.75" y="1.75" width="7" height="5" rx="1.2" />
      <rect x="10.75" y="1.75" width="3.5" height="5" rx="1.2" />
      <rect x="1.75" y="8.75" width="12.5" height="5.5" rx="1.2" />
    </svg>
  );
}

function DashboardRow({ d, onOpen }: { d: DashboardSummaryOut; onOpen(id: string, newTab: boolean): void }) {
  const ago = savedAgo(d.updated_at, Date.now());
  return (
    <li className={s.item}>
      <button type="button" className={s.open} aria-keyshortcuts="Control+Enter"
        onClick={(e: MouseEvent) => onOpen(d.id, toNewTab(e))}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key !== "Enter" || !toNewTab(e)) return;
          e.preventDefault();
          e.stopPropagation();
          onOpen(d.id, true);
        }}>
        <GridMark />
        <span className={s.title}>{d.title}</span>
        <span className={s.meta}>
          <span>{panels(d.panel_count)}</span>
          {ago && <span>{ago}</span>}
        </span>
      </button>
    </li>
  );
}

/** A project's ready-made views: what each shows, what its sources lack, and Copy to edit. */
function ReadyMadeViews({ projectId, readyMade, opener, onOpen, clusterDown, manyPrometheus }: {
  projectId: string; readyMade: boolean; opener: Opener; onOpen(id: string, newTab: boolean): void; clusterDown: boolean; manyPrometheus: boolean;
}) {
  const ready = useReadyMade(projectId);
  const copy = useCopyToEdit(opener);
  if (!readyMade) return <p className={s.muted}>{NO_READY}</p>;
  if (ready.isError) return <p className={s.bad} role="alert">{failure(ready.error, "reload the page")}</p>;
  if (!ready.data?.length) return null;
  return (
    <>
      <h3 id={`ready-${projectId}`} className={s.subheading}>Ready-made views</h3>
      <ul className={s.readyList} aria-labelledby={`ready-${projectId}`}>
        {ready.data.map((r) => {
          const busy = copy.busy === r.id;
          return (
            <li key={r.id} className={s.ready}>
              <div className={s.readyText}>
                <button type="button" className={s.readyTitle} onClick={(e) => onOpen(r.id, toNewTab(e))}>{r.title}</button>
                {r.description && <p className={s.description}>{r.description}</p>}
                {manyPrometheus && r.source_name && <p className={s.reads}>{`Reads ${r.source_name}.`}</p>}
                {r.notes.map((n) => <p key={n} className={s.readyNote}>{n}</p>)}
                {!r.checked && r.check_message && <p className={s.readyNote}>{clusterDown ? CANT_CHECK : r.check_message}</p>}
                {copy.error?.from === r.id && <p className={s.bad} role="alert">{copy.error.text}</p>}
              </div>
              <button type="button" className={s.copy} aria-label={`Copy to edit ${r.title}`} aria-disabled={copy.busy !== null || undefined}
                onClick={() => copy.copy(r.id, projectId)}>
                {busy ? "Copying…" : "Copy to edit"}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function OwnerDashboards({ owner, tabId, nav, openInNewTab, readyMade = false, clusterDown = false, manyPrometheus = false }: {
  owner: Owner;
  /** The tab the page is in: a dashboard made here opens in it (or a new one when it holds unsaved edits). */
  tabId: string;
  nav: MonitoringPageProps["nav"];
  openInNewTab(view: MonitoringView): void;
  /** A project with a Prometheus-compatible or Loki source linked (ready-made views come from them). */
  readyMade?: boolean;
  /** The project's cluster can't be reached, which its page says once: a view doesn't say why again. */
  clusterDown?: boolean;
  /** The project links two or more Prometheus sources: each ready-made view says which one it reads. */
  manyPrometheus?: boolean;
}) {
  const list = useOwnerDashboards(owner);
  const [creating, setCreating] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const opener: Opener = { tabId, nav, openInNewTab };
  const open = (id: string, newTab: boolean) => {
    const view: MonitoringView = { page: "dashboard", id };
    if (newTab) openInNewTab(view);
    else nav.navigate(view, "push");
  };

  return (
    <div className={s.owner}>
      <div className={s.bar}>
        <button ref={newButton} type="button" className={s.primary} aria-label={`New dashboard for ${owner.name}`} onClick={() => setCreating(true)}>
          <span className={s.plus} aria-hidden="true">+</span>New dashboard
        </button>
      </div>
      {list.isPending && <p className={s.muted} role="status">Loading dashboards…</p>}
      {list.isError && (
        <div className={s.problem} role="alert">
          <p className={s.bad}>{failure(list.error, "try again")}</p>
          <button type="button" className={s.secondary} onClick={() => void list.refetch()}>Try again</button>
        </div>
      )}
      {list.data && list.data.length === 0 && <p className={s.muted}>{EMPTY[owner.kind]}</p>}
      {list.data && list.data.length > 0 && (
        <ul className={s.list} aria-label={`Dashboards of ${owner.name}`}>
          {list.data.map((d) => <DashboardRow key={d.id} d={d} onOpen={open} />)}
        </ul>
      )}
      {owner.kind === "project" && <ReadyMadeViews projectId={owner.id} readyMade={readyMade} opener={opener} onOpen={open} clusterDown={clusterDown} manyPrometheus={manyPrometheus} />}
      {creating && (
        <NewDashboardDialog owner={owner} restoreFocusTo={newButton} onCancel={() => setCreating(false)}
          onCreated={(out) => { setCreating(false); openMade(out, { edit: true }, opener); }} />
      )}
    </div>
  );
}
