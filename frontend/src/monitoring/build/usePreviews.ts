// Live previews for the candidates on screen: one batch for all of them, a moment after the list
// stops changing. A change aborts the batch in flight, and an answer for an older list is dropped,
// so a card never shows data that belongs to another query. A failure says why; it never keeps an
// old chart.

import { useEffect, useRef, useState } from "react";
import { DashboardRequestError, runBatch } from "../dashboards/api";
import type { BatchItemOut } from "../dashboards/api";
import type { PanelSpec } from "../dashboards/schema";
import { buildPanelRun, mergePanelResults } from "../dashboards/runPanel";
import type { DashboardOwner, PanelData, PanelRun } from "../dashboards/runPanel";
import type { ResolvedVars } from "../dashboards/interpolate";
import { candidatePanel, type Candidate } from "./candidates";

export const MAX_PREVIEWS = 3;
export const PREVIEW_DEBOUNCE_MS = 250;
/** Grid columns a preview is sized for; it sets the step. */
export const PREVIEW_WIDTH = 4;
export const PREVIEW_LOG_LINES = 3;
const MAX_ITEMS = 64;
const LIMITED = "Preview limited to the first projects.";
const NO_ANSWER = "The preview didn't answer. Try again.";

export type PreviewState =
  | { status: "loading" }
  | { status: "done"; data: PanelData }
  | { status: "failed"; message: string };

export interface PreviewContext {
  owner: DashboardOwner | null;
  ownerName: string;
  vars: ResolvedVars;
  range: { start: number; end: number };
}

const LOADING: PreviewState = { status: "loading" };

function panelFor(c: Candidate, owner: DashboardOwner): PanelSpec {
  const panel = candidatePanel(c, `preview-${c.key}`, owner.kind) as unknown as PanelSpec;
  const options = panel.type === "logs" ? { ...panel.options, limit: PREVIEW_LOG_LINES } : panel.options;
  return { ...panel, options, layout: { x: 0, y: 0, w: PREVIEW_WIDTH, h: 6 } } as PanelSpec;
}

function ownerKey(owner: DashboardOwner | null): string {
  if (!owner) return "";
  return owner.kind === "project"
    ? `p:${owner.project.id}:${owner.project.links.map((l) => l.source_id).join(",")}`
    : `g:${owner.group.id}:${owner.members.map((m) => `${m.id}/${m.links.map((l) => l.source_id).join(",")}`).join(",")}`;
}

/** The previews of the first `MAX_PREVIEWS` candidates, by candidate key. */
export function usePreviews(candidates: Candidate[], ctx: PreviewContext): Record<string, PreviewState> {
  const shown = candidates.slice(0, MAX_PREVIEWS);
  const key = JSON.stringify([
    shown.map((c) => [c.key, c.expr, c.panelType, c.sourceId, c.options ?? null]),
    ownerKey(ctx.owner), ctx.vars, ctx.range.start, ctx.range.end,
  ]);
  const [answered, setAnswered] = useState<{ key: string; map: Record<string, PreviewState> }>({ key: "", map: {} });
  const latest = useRef({ shown, ctx });
  latest.current = { shown, ctx };

  useEffect(() => {
    const { shown: list, ctx: c } = latest.current;
    const owner = c.owner;
    if (!owner || list.length === 0) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      const runs: { cand: Candidate; panel: PanelSpec; run: PanelRun; from: number }[] = [];
      const requests: PanelRun["requests"] = [];
      const map: Record<string, PreviewState> = {};
      for (const cand of list) {
        const panel = panelFor(cand, owner);
        const run = buildPanelRun({ panel, owner, vars: c.vars, range: c.range, ownerName: c.ownerName });
        if (requests.length + run.requests.length > MAX_ITEMS) {
          map[cand.key] = { status: "failed", message: LIMITED };
          continue;
        }
        runs.push({ cand, panel, run, from: requests.length });
        requests.push(...run.requests);
      }
      const settle = (results: BatchItemOut[] | Error) => {
        if (ac.signal.aborted) return;
        for (const { cand, panel, run, from } of runs) {
          if (results instanceof Error) {
            map[cand.key] = { status: "failed", message: results.message || NO_ANSWER };
            continue;
          }
          const data = mergePanelResults(panel, run, results.slice(from, from + run.requests.length), owner.kind);
          map[cand.key] = data.state === "error" || data.state === "unreachable" || data.state === "noQuery"
            ? { status: "failed", message: data.problems[0] ?? NO_ANSWER }
            : { status: "done", data };
        }
        setAnswered({ key, map });
      };
      if (requests.length === 0) return settle([]);
      runBatch(requests, ac.signal).then(settle, (err: unknown) => {
        if (ac.signal.aborted) return;
        settle(err instanceof DashboardRequestError || err instanceof Error ? err : new Error(NO_ANSWER));
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [key]);

  const current = answered.key === key ? answered.map : {};
  const out: Record<string, PreviewState> = {};
  for (const c of shown) out[c.key] = current[c.key] ?? LOADING;
  return out;
}
