// The Alerts page's rule list as rows: what fires now pinned under "Firing", then every rule under
// its project or group. Pure: the page renders these rows and moves through the rule rows.

import type { OverviewOut, RuleOut, Severity, TargetState } from "../api";
import { sinceShort, stateTone, type Tone } from "../format";

/** A row's colour: a state's tone, or a severity's (info is the focus lavender). */
export type RowTone = Tone | "focus";

export interface ListRow {
  /** Unique in the list; a rule shows twice while it fires (pinned, and under its owner). */
  key: string;
  kind: "heading" | "rule";
  label: string;
  ruleId?: string;
  state?: TargetState;
  /** The words on the right: how long it has fired (pinned), or its state in lower case. */
  right?: string;
  tone?: RowTone;
  /** Pinned rows draw a dot in their severity's colour. */
  dot?: boolean;
  /** Firing, with every firing alert silenced: the row carries a muted "Silenced" tag. */
  silenced?: boolean;
}

/** A state as the list says it, in lower case (as the A2 prototype). */
export const LIST_STATE: Record<TargetState, string> = {
  ok: "ok",
  pending: "pending",
  firing: "firing",
  no_data: "no data",
  unreachable: "can't check",
  error: "error",
  paused: "paused",
  waiting: "loading",
  not_applied: "not applied",
};

const SEVERITY_TONE: Record<Severity, RowTone> = { critical: "bad", warning: "warn", info: "focus" };

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows: **Firing** with one row per firing rule (in the overview's order: severity, then how
 * long), then one heading per project (its name) and per group (`Group · {name}`), projects first,
 * each sorted by name, each listing its rules by name. With nothing firing there is no Firing
 * heading. `now` is milliseconds since the epoch.
 */
export function listRows(rules: RuleOut[], overview: OverviewOut | undefined, now: number): ListRow[] {
  const rows: ListRow[] = [];
  const known = new Map(rules.map((r) => [r.id, r]));

  // Pinned: what fires now, once per rule (a group rule fires per project; the longest counts).
  const pinned = new Map<string, { name: string; severity: Severity; since: number }>();
  for (const f of overview?.firing ?? []) {
    if (!known.has(f.rule_id)) continue;
    const since = Date.parse(f.since);
    const was = pinned.get(f.rule_id);
    if (!was) pinned.set(f.rule_id, { name: known.get(f.rule_id)!.name, severity: f.severity, since });
    else if (since < was.since) was.since = since;
  }
  // A rule is silenced when every firing alert of every project it fires in is silenced.
  const silenced = new Map<string, boolean>();
  for (const f of overview?.firing ?? []) {
    const all = f.instances > 0 && f.silenced >= f.instances;
    silenced.set(f.rule_id, (silenced.get(f.rule_id) ?? true) && all);
  }
  if (pinned.size > 0) {
    rows.push({ key: "heading:firing", kind: "heading", label: "Firing" });
    for (const [id, p] of pinned) {
      rows.push({
        key: `firing:${id}`, kind: "rule", label: p.name, ruleId: id, state: "firing",
        right: Number.isFinite(p.since) ? sinceShort((now - p.since) / 1000) : "firing", tone: SEVERITY_TONE[p.severity], dot: true,
        silenced: silenced.get(id) || undefined,
      });
    }
  }

  // Every rule under its owner.
  const owners = new Map<string, { kind: "project" | "group"; name: string; rules: RuleOut[] }>();
  for (const r of rules) {
    const key = `${r.scope.kind}:${r.scope.id}`;
    const owner = owners.get(key) ?? { kind: r.scope.kind, name: r.scope.name, rules: [] };
    owner.rules.push(r);
    owners.set(key, owner);
  }
  const ordered = [...owners.entries()].sort(([, a], [, b]) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === "project" ? -1 : 1));
  for (const [key, owner] of ordered) {
    rows.push({ key: `heading:${key}`, kind: "heading", label: owner.kind === "group" ? `Group · ${owner.name}` : owner.name });
    for (const r of [...owner.rules].sort((a, b) => byName(a.name, b.name) || byName(a.id, b.id))) {
      const state: TargetState = r.paused ? "paused" : r.state;
      const quiet = state === "firing" && silenced.get(r.id) ? true : undefined;
      rows.push({ key: `rule:${key}:${r.id}`, kind: "rule", label: r.name, ruleId: r.id, state, right: LIST_STATE[state], tone: stateTone(state), silenced: quiet });
    }
  }
  return rows;
}
