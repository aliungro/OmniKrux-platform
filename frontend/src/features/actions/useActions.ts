import { createContext, useCallback, useContext, useMemo } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { getJson, HttpError, postJson } from "../../api/http";
import type { ApplyResult, Job, Plan, PlanRequest, Revision } from "../../api/types";

/** What a successful apply can have changed: the audit log and the details of the object. */
const AFTER_APPLY = ["audit", "resource-describe", "resource-yaml", "describe", "pod-yaml", "revisions"] as const;

export const JOB_POLL_MS = 1000;

export interface Actions {
  /** Asks the server to work the change out; nothing changes yet. */
  plan: (req: PlanRequest) => Promise<Plan>;
  /**
   * Applies a plan by its id. The body is `{}` or `{"confirm_text": …}`: the cluster, the object
   * and the change itself come only from the plan the server keeps.
   */
  apply: (planId: string, confirmText?: string) => Promise<ApplyResult>;
}

export function useActions(): Actions {
  const queryClient = useQueryClient();
  const plan = useCallback(
    (req: PlanRequest) => postJson<Plan>("/api/actions/plan", { action: req.action, target: req.target, params: req.params ?? {} }),
    [],
  );
  const apply = useCallback(
    async (planId: string, confirmText?: string) => {
      const body = confirmText === undefined ? {} : { confirm_text: confirmText };
      const out = await postJson<ApplyResult>(`/api/actions/${encodeURIComponent(planId)}/apply`, body);
      for (const key of AFTER_APPLY) void queryClient.invalidateQueries({ queryKey: [key] });
      return out;
    },
    [queryClient],
  );
  return useMemo(() => ({ plan, apply }), [plan, apply]);
}

function jobPath(jobId: string): string {
  return `/api/actions/jobs/${encodeURIComponent(jobId)}`;
}

/** A job (a drain) as it is now, read every second while it runs, and not after. */
export function useJob(jobId: string | null): UseQueryResult<Job> {
  return useQuery({
    queryKey: ["action-job", jobId],
    queryFn: () => getJson<Job>(jobPath(jobId!)),
    enabled: jobId !== null,
    retry: false,
    refetchInterval: (query) => {
      const { data, error } = query.state;
      if (error instanceof HttpError && error.status === 404) return false; // forgotten: nothing to wait for
      return data === undefined || data.state === "running" ? JOB_POLL_MS : false;
    },
  });
}

/** Stops a running job; what it already did stays done (a drained node stays cordoned). */
export function cancelJob(jobId: string): Promise<Job> {
  return postJson<Job>(`${jobPath(jobId)}/cancel`);
}

/** A deployment's revisions, newest first, for a rollback. */
export function useRevisions(clusterId: string, namespace: string, name: string): UseQueryResult<Revision[]> {
  return useQuery({
    queryKey: ["revisions", clusterId, namespace, name],
    queryFn: () =>
      getJson<Revision[]>(
        `/api/clusters/${encodeURIComponent(clusterId)}/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/revisions`,
      ),
    retry: false,
  });
}

/**
 * Starts a change: plans it and opens the review dialog. Resolves when the dialog closes, with what
 * was applied (null: cancelled, or replaced by a newer start); rejects with the server's words when
 * the plan can't be made, for the caller to show where the change was asked for.
 */
export type StartAction = (req: PlanRequest) => Promise<ApplyResult | null>;

export const StartActionContext = createContext<StartAction | null>(null);

/** Null outside an `ActionsProvider`: the details then offer no change tools. */
export function useStartAction(): StartAction | null {
  return useContext(StartActionContext);
}
