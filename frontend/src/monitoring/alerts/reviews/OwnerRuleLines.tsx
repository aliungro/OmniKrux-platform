// The two alert lines of a project's or group's delete review: the rules that go with it, and the
// rules still applied in a cluster, which have to be removed there first (each with its own Review).
// The review leaves empty lists out of its answer; `ruleRefs` reads a missing one as none.

import { useState } from "react";
import { failure } from "../../../api/http";
import { getRule, ruleRefs, type RuleRefOut } from "../api";
import { useToolReviews } from "./useToolReviews";
import s from "./OwnerRuleLines.module.css";

const names = (list: RuleRefOut[]) => list.map((x) => x.name).join(", ");

export const rulesGoWords = (list: RuleRefOut[]) => `Alert rules that go with it: ${names(list)}.`;
export const rulesInClusterWords = (cluster: string, list: RuleRefOut[]) =>
  `Remove its rules that run in ${cluster} first: ${names(list)}. Each opens its own review.`;

/** Whether the owner's delete has to wait: some of its rules still run in a cluster. */
export const waitsForClusterRules = (review: { cluster_rules?: RuleRefOut[] }): boolean => ruleRefs(review.cluster_rules).length > 0;

export function OwnerRuleLines({ alertRules, clusterRules, cluster, projectId, onReviewed }: {
  alertRules: RuleRefOut[] | undefined;
  clusterRules: RuleRefOut[] | undefined;
  /** Where they run, in words ("kind-dev", "kind-dev and prod-east"). */
  cluster: string;
  /** A project's own id: only its targets are reviewed. A group's reviews every cluster target. */
  projectId?: string;
  /** A review applied a change: the owner's review is read again. */
  onReviewed(): void;
}) {
  const reviews = useToolReviews();
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const goes = ruleRefs(alertRules);
  const blocked = ruleRefs(clusterRules);

  const review = async (rule: RuleRefOut) => {
    if (working) return;
    setWorking(rule.id);
    setProblem(null);
    try {
      const out = await getRule(rule.id);
      const targets = out.targets.filter((t) => t.tool === "prometheus_rule" && (projectId === undefined || t.project_id === projectId));
      let applied = false;
      for (const t of targets) {
        if ((await reviews.reviewTarget(t.id, out.name, t.project_name)) === "applied") applied = true;
      }
      if (applied) onReviewed();
    } catch (err) {
      setProblem(failure(err, "try again"));
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
          <ul className={s.list}>
            {blocked.map((r) => (
              <li key={r.id} className={s.item}>
                <span>{r.name}</span>
                <button type="button" className={s.review} aria-label={`Review ${r.name}`} aria-disabled={working !== null || undefined}
                  onClick={() => void review(r)}>Review</button>
              </li>
            ))}
          </ul>
          {problem && <p className={s.problem} role="alert">{problem}</p>}
        </div>
      )}
    </>
  );
}
