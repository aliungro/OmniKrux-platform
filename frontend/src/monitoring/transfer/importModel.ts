// The review of an import as the page holds it: the preview the server sent, where the dashboards
// go, which source each data source reads, and which dashboards are chosen under which titles.
// Pure: the page turns it into the commit body. Nothing here is stored anywhere (a file's text and
// the preview stay in the page's state only, never a cache, a URL or the browser's storage).
import type { OwnerKind } from "../dashboards/schema";
import type { CommitDashboardIn, ImportCommitIn, ImportInput, ImportPreviewOut, MappingIn, NewGroupIn, PreviewDashboardOut, TargetIn } from "./api";

export type ReviewTarget = TargetIn | { newGroup: NewGroupIn };

export type ReviewState = {
  preview: ImportPreviewOut;
  target: ReviewTarget | null;
  mapping: Record<string, MappingIn>;
  chosen: Record<string, { use: boolean; title: string }>;
};

/** The backend's longest dashboard title. */
export const MAX_TITLE = 120;
/** A file larger than this is refused before it is read (the backend's own limit). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// --- Words -------------------------------------------------------------------------------------

export const LEAD = "Bring in dashboards from an OmniKrux export or from Grafana. Nothing is saved until you've seen what converts.";
export const TOO_BIG = "That file is larger than 10 MB. Export fewer dashboards at a time.";
export const UNREADABLE = "Couldn't read that file. Choose it again.";
export const CHANGED = "Something changed since you checked. Here is the new result.";
export const STALE = "This result is out of date. Check what converts again before importing.";
export const GROUP_LINE = "In a group dashboard each project uses its own source.";
export const NO_PROJECT = "Set up a project first, then import into it.";
export const NO_SECRETS = "Passwords and tokens aren't in exports. A source that needs them asks for them when you add it.";
export const EMPTY_TITLE = "Give this dashboard a title.";
export const LONG_TITLE = `Keep the title to ${MAX_TITLE} characters.`;
export const LEAVE_TITLE = "Import dashboards";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const takenTitleWords = (title: string, owner: string) => `A dashboard named "${title}" already exists in ${owner}. Pick another name.`;
export const sameTitleWords = (title: string) => `Another dashboard here is also called "${title}". Pick another name.`;
export const importWords = (n: number) => (n === 1 ? "Import 1 dashboard" : `Import ${n} dashboards`);
export const panelsWords = (n: number) => plural(n, "panel", "panels");
export const alertsWords = (n: number) => plural(n, "alert", "alerts");

export function summaryWords(s: ReviewState): string {
  const k = skippedCount(s);
  const rest = k === 0 ? "everything converts" : `${plural(k, "thing", "things")} won't be copied`;
  return `${chosenCount(s)} of ${s.preview.dashboards.length} dashboards chosen · ${rest}`;
}

/** Why a dashboard can't be imported, from its first problem. */
export function notImportableWords(d: PreviewDashboardOut): string {
  const p = d.problems[0];
  if (!p) return "This dashboard can't be imported.";
  const message = p.message.replace(/\.+$/, "");
  return `This dashboard can't be imported: ${p.path ? `${p.path}: ${message}` : message}.`;
}

/** A file's size as people read it. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return plural(bytes, "byte", "bytes");
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

// --- The model ---------------------------------------------------------------------------------

export const isNewGroup = (t: ReviewTarget | null): t is { newGroup: NewGroupIn } => t !== null && "newGroup" in t;

/** The kind of place the dashboards go: a new group is a group. */
export function targetKind(t: ReviewTarget | null): OwnerKind | null {
  if (t === null) return null;
  return isNewGroup(t) ? "group" : t.kind;
}

export const sameTarget = (a: TargetIn | null, b: TargetIn | null) => (a === null || b === null ? a === b : a.kind === b.kind && a.id === b.id);

function suggestedMapping(p: ImportPreviewOut): Record<string, MappingIn> {
  const out: Record<string, MappingIn> = {};
  for (const r of p.sources) out[r.key] = r.leave_out ? { key: r.key, leave_out: true } : { key: r.key, source_id: r.suggestion };
  return out;
}

/** Every importable dashboard chosen under its suggested title; each source as suggested. */
export function initialReview(p: ImportPreviewOut, target: TargetIn | null): ReviewState {
  const chosen: ReviewState["chosen"] = {};
  for (const d of p.dashboards) chosen[d.key] = { use: d.importable, title: d.suggested_title };
  return { preview: p, target, mapping: suggestedMapping(p), chosen };
}

const sameMapping = (a: MappingIn | undefined, b: MappingIn | undefined) =>
  !!a && !!b && !!a.leave_out === !!b.leave_out && (a.leave_out || (a.source_id ?? null) === (b.source_id ?? null));

/**
 * A new preview of the same input (another target, or a re-check after a refusal): what the user
 * chose by hand stays where its key still exists; anything they left as suggested follows the new
 * suggestions. A source picked by hand is kept only with `keepSources` (same target): another
 * project links other sources, so there its choice starts again from the suggestion (leaving a
 * source out is kept either way).
 */
export function rebaseReview(old: ReviewState, p: ImportPreviewOut, target: ReviewTarget | null, keepSources: boolean): ReviewState {
  const next = initialReview(p, null);
  next.target = target;
  const before = new Map(old.preview.dashboards.map((d) => [d.key, d]));
  for (const d of p.dashboards) {
    const was = old.chosen[d.key];
    const had = before.get(d.key);
    if (!was || !had) continue;
    next.chosen[d.key] = {
      use: d.importable && was.use,
      title: was.title !== had.suggested_title ? was.title : d.suggested_title,
    };
  }
  const oldSuggested = suggestedMapping(old.preview);
  for (const r of p.sources) {
    const was = old.mapping[r.key];
    if (!was || sameMapping(was, oldSuggested[r.key])) continue;
    if (was.leave_out || keepSources) next.mapping[r.key] = was;
  }
  return next;
}

const usable = (s: ReviewState, d: PreviewDashboardOut) => d.importable && !!s.chosen[d.key]?.use;

export const chosenCount = (s: ReviewState): number => s.preview.dashboards.filter((d) => usable(s, d)).length;

/** What won't be copied, counted over the chosen dashboards. */
export const skippedCount = (s: ReviewState): number =>
  s.preview.dashboards.reduce((n, d) => n + (usable(s, d) ? d.skipped.length : 0), 0);

/**
 * What is wrong with a chosen dashboard's title, else null: empty, too long, taken where the
 * dashboards go (`takenTitles`, named `ownerName`), or the same as another chosen one's.
 */
export function titleProblem(s: ReviewState, key: string, takenTitles: ReadonlySet<string>, ownerName = "this place"): string | null {
  const own = s.preview.dashboards.find((d) => d.key === key);
  if (!own || !usable(s, own)) return null;
  const title = s.chosen[key].title.trim();
  if (title === "") return EMPTY_TITLE;
  if (title.length > MAX_TITLE) return LONG_TITLE;
  if (takenTitles.has(title)) return takenTitleWords(title, ownerName);
  const twin = s.preview.dashboards.some((d) => d.key !== key && usable(s, d) && s.chosen[d.key].title.trim() === title);
  return twin ? sameTitleWords(title) : null;
}

/** The commit for the review: where, the mapping (none for a group), and each chosen dashboard's title and digest. */
export function commitBody(input: ImportInput, s: ReviewState): ImportCommitIn {
  const dashboards: CommitDashboardIn[] = s.preview.dashboards
    .filter((d) => usable(s, d))
    .map((d) => ({ key: d.key, title: s.chosen[d.key].title.trim(), digest: d.digest }));
  const group = targetKind(s.target) === "group";
  const mapping = group ? [] : s.preview.sources.map((r) => s.mapping[r.key] ?? { key: r.key, source_id: null });
  if (isNewGroup(s.target)) {
    const { name, project_ids } = s.target.newGroup;
    return { input, target: null, new_group: { name: name.trim(), project_ids }, mapping, dashboards };
  }
  return { input, target: s.target, new_group: null, mapping, dashboards };
}
