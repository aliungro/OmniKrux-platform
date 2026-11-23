// The two alert lines of a project's or group's delete review: the rules that go with it, and the
// rules still applied in a cluster, which have to be removed there first. A project's own rule is
// removed from here (Review deletes it, then opens its removal in the cluster for confirming); a
// group's rule can't be removed by a project, so its button opens the rule on the Alerts page.
// The review leaves empty lists out of its answer; `ruleRefs` reads a missing one as none.

import { useEffect, useRef, useState } from "react";
import { failure } from "../../../api/http";
import { deleteRule, getRule, ruleDeleteReview, ruleRefs, useRules, type RuleRefOut } from "../api";
import { useToolReviews } from "./useToolReviews";
import s from "./OwnerRuleLines.module.css";

const names = (list: RuleRefOut[]) => list.map((x) => x.name).join(", ");

export const rulesGoWords = (list: RuleRefOut[]) => `Alert rules that go with it: ${names(list)}.`;
export const rulesInClusterWords = (cluster: string, list: RuleRefOut[]) =>
  `Remove its rules that run in ${cluster} first: ${names(list)}. Each opens its own review.`;
export const GROUP_RULE_WORDS = "A group's rule can't be removed from a project. Open it to remove it there, or take this project out of the group.";
export const REVIEW_WORDS = "Review removes the rule, then opens its removal in the cluster for you to confirm.";

/** Whether the owner's delete has to wait: some of its rules still run in a cluster. */
export const waitsForClusterRules = (review: { cluster_rules?: RuleRefOut[] }): boolean => ruleRefs(review.cluster_rules).length > 0;

const inWords = (list: string[]) => (list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

export function OwnerRuleLines({ alertRules, clusterRules, owner, clusterOf, fallbackCluster, onOpenRule, onReviewed }: {
  alertRules: RuleRefOut[] | undefined;
  clusterRules: RuleRefOut[] | undefined;
  /** A project (its own rules can be removed here) or a group (its rules are opened). */
  owner: { kind: "project" | "group"; id: string };
  /** The name of the cluster a project runs in, when known. */
  clusterOf(projectId: string): string | null;
  /** Said when the clusters the rules run in aren't known yet. */
  fallbackCluster: string;
  /** Opens a rule on the Alerts page. */
  onOpenRule(ruleId: string): void;
  /** A rule's removal finished (or was left): the owner's review is read again. */
  onReviewed(): Promise<void>;
}) {
  const reviews = useToolReviews();
  const rules = useRules();
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const goes = ruleRefs(alertRules);
  const blocked = ruleRefs(clusterRules);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Where the keyboard was in the list when a rule went: it moves to the rule now in its place.
  const was = useRef<number | null>(null);
  const key = blocked.map((r) => r.id).join(",");
  useEffect(() => {
    const at = was.current;
    if (at === null || blocked.length === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    was.current = null;
    buttons.current.get(blocked[Math.min(at, blocked.length - 1)].id)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const byId = new Map((rules.data ?? []).map((r) => [r.id, r]));
  /** A rule this project owns itself; anything else (a group's rule) is opened, not removed. */
  const isOwn = (id: string) => {
    const rule = byId.get(id);
    return owner.kind === "project" && rule !== undefined && rule.scope.kind === "project" && rule.scope.id === owner.id;
  };
  const ownCount = blocked.filter((r) => isOwn(r.id)).length;

  const clusterNames = [...new Set(blocked.flatMap((r) => (byId.get(r.id)?.targets ?? [])
    .filter((t) => t.tool === "prometheus_rule" && (owner.kind === "group" || t.project_id === owner.id))
    .flatMap((t) => clusterOf(t.project_id) ?? [])))];
  const cluster = clusterNames.length > 0 ? inWords(clusterNames) : fallbackCluster;

  const remove = async (rule: RuleRefOut, index: number) => {
    if (working) return;
    setWorking(rule.id);
    setProblem(null);
    was.current = index;
    try {
      const current = await getRule(rule.id);
      // A rule not being removed yet is removed now (its targets are marked leaving), then each
      // target's removal in the cluster is reviewed.
      let changes = [] as Awaited<ReturnType<typeof deleteRule>>["changes"];
      if (!current.removing) {
        const asked = await ruleDeleteReview(rule.id);
        changes = (await deleteRule(rule.id, asked.token)).changes;
      } else {
        changes = current.targets.filter((t) => t.tool === "prometheus_rule" && t.leaving)
          .map((t) => ({ target_id: t.id, rule_id: current.id, rule_name: current.name, project_id: t.project_id, project_name: t.project_name, kind: "review" as const, message: null }));
      }
      for (const c of changes) {
        if (c.kind === "failed") setProblem(c.message ?? `"${c.rule_name}" couldn't be removed from ${c.project_name}'s cluster.`);
        else if (c.kind === "review") await reviews.reviewTarget(c.target_id, c.rule_name, c.project_name);
      }
      await onReviewed();
    } catch (err) {
      setProblem(failure(err, "try again"));
      try { await onReviewed(); } catch { /* the review shows its own words */ }
    } finally {
      setWorking(null);
    }
  };

  return (
    <>
      {goes.length > 0 && <p>{rulesGoWords(goes)}</p>}
      {blocked.length > 0 && (
        <div className={s.blocked}>
          <p>{rulesInClusterWords(cluster, blocked)}</p>
          {ownCount > 0 && <p className={s.hint}>{REVIEW_WORDS}</p>}
          {blocked.some((r) => !isOwn(r.id)) && owner.kind === "project" && <p className={s.hint}>{GROUP_RULE_WORDS}</p>}
          <ul className={s.list}>
            {blocked.map((r, i) => {
              const own = isOwn(r.id);
              return (
                <li key={r.id} className={s.item}>
                  <span>{r.name}</span>
                  <button type="button" ref={(el) => { if (el) buttons.current.set(r.id, el); else buttons.current.delete(r.id); }}
                    className={s.review} aria-label={`${own ? "Review" : "Open rule"} ${r.name}`} aria-disabled={working !== null || undefined}
                    onClick={() => (own ? void remove(r, i) : onOpenRule(r.id))}>{own ? "Review" : "Open rule"}</button>
                </li>
              );
            })}
          </ul>
          {problem && <p className={s.problem} role="alert">{problem}</p>}
        </div>
      )}
    </>
  );
}
