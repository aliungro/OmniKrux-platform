import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { failure } from "../../api/http";
import type { ActionName, ResourceRow } from "../../api/types";
import { ScaleForm, RollbackForm } from "../actions/forms";
import { keyedTools, toolsFor, TOOL_LABEL, type ToolId } from "../actions/tools";
import { useStartAction } from "../actions/useActions";
import { YamlEditor } from "../actions/YamlEditor";
import { capsOf, isEditable, toolShortcut } from "../chrome/shortcuts";
import { textColumn } from "../territories/model";
import k from "../chrome/key.module.css";
import s from "./Inspector.module.css";

/** A key press on the row that asks the details for a tool; `seq` tells two presses apart. */
export interface ToolIntent {
  tool: ToolId;
  seq: number;
}

/** The count a workload runs at, from its row's Ready column ("2/3" → 3); 1 when it can't tell. */
export function desiredReplicas(row: ResourceRow): number {
  const ready = textColumn(row, "ready");
  const desired = ready?.split("/")[1];
  return desired !== undefined && /^\d+$/.test(desired) ? Number(desired) : 1;
}

/**
 * The change tools of one object's details: the buttons (with their keys), the inline forms (scale,
 * rollback), the YAML editor, and where a plan that couldn't be made says why. A change is planned
 * through the actions provider, which opens the review dialog on the plan.
 */
export function useTools({
  row,
  kindKey,
  verbs,
  onNodeShell,
  onEditing,
  intent,
  onIntentDone,
}: {
  row: ResourceRow;
  kindKey: string;
  verbs: readonly string[];
  onNodeShell?: (row: ResourceRow, node: string) => void;
  /** Editing starts: show the YAML tab. */
  onEditing: () => void;
  intent?: ToolIntent | null;
  onIntentDone?: () => void;
}) {
  const start = useStartAction();
  const tools = start ? toolsFor(kindKey, verbs) : [];
  const [open, setOpen] = useState<"edit" | "scale" | "rollback" | null>(null);
  const [busy, setBusy] = useState<ToolId | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Plans a change on this object; true when it was applied. */
  const request = async (tool: ToolId, action: ActionName, params: Record<string, unknown> = {}): Promise<boolean> => {
    if (!start) return false;
    setBusy(tool);
    setError(null);
    try {
      const target = { cluster_id: row.cluster_id, kind_key: kindKey, namespace: row.namespace, name: row.name };
      return (await start({ action, target, params })) !== null;
    } catch (err) {
      setError(failure(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const run = (tool: ToolId) => {
    if (busy !== null || !tools.includes(tool)) return;
    setError(null);
    switch (tool) {
      case "edit":
        setOpen("edit");
        onEditing();
        return;
      case "scale":
      case "rollback":
        setOpen(tool);
        return;
      case "nodeShell":
        onNodeShell?.(row, row.name);
        return;
      default:
        setOpen(null);
        void request(tool, tool);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  // A tool's key pressed on the row: run it once the details are open.
  useEffect(() => {
    if (!intent) return;
    runRef.current(intent.tool);
    onIntentDone?.();
  }, [intent, onIntentDone]);

  const close = useCallback(() => {
    setOpen(null);
    setError(null);
  }, []);

  /** Tool keys pressed inside the details, never in a field, the editor or a terminal. */
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    const id = toolShortcut(e, keyedTools(tools));
    if (id === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    run(id as ToolId);
  };

  const buttons: ReactNode = tools.map((tool) => {
    const caps = tool === "rollback" ? [] : capsOf(tool);
    return (
      <button
        key={tool}
        type="button"
        className={`${s.btn}${tool === "delete" ? ` ${s.danger}` : ""}`}
        disabled={busy !== null}
        aria-pressed={open === tool ? true : undefined}
        onClick={() => run(tool)}
      >
        {busy === tool ? "Reviewing…" : TOOL_LABEL[tool]}
        {caps.map((c) => (
          <span key={c} className={`${k.k} ${s.k}`} aria-hidden="true">
            {c}
          </span>
        ))}
      </button>
    );
  });

  // Under the tab bar: a scale or rollback form, or why a change couldn't be planned.
  let strip: ReactNode = null;
  if (open === "scale") {
    strip = (
      <ScaleForm
        name={row.name}
        initial={desiredReplicas(row)}
        busy={busy === "scale"}
        error={error}
        onCancel={close}
        onReview={(replicas) => void request("scale", "scale", { replicas }).then((applied) => applied && close())}
      />
    );
  } else if (open === "rollback") {
    strip = (
      <RollbackForm
        clusterId={row.cluster_id}
        namespace={row.namespace ?? ""}
        name={row.name}
        busy={busy === "rollback"}
        error={error}
        onCancel={close}
        onReview={(revision) => void request("rollback", "rollback", { revision }).then((applied) => applied && close())}
      />
    );
  } else if (error && open === null) {
    strip = (
      <p className={s.toolError} role="alert">
        {error}
      </p>
    );
  }

  /** The YAML tab while editing; null otherwise. */
  const editor = (yaml: string | undefined): ReactNode =>
    open === "edit" && yaml !== undefined ? (
      <YamlEditor
        yaml={yaml}
        label={`Edit ${row.kind} YAML`}
        busy={busy === "edit"}
        error={error}
        onDiscard={close}
        onReview={(text) => void request("edit", "edit", { yaml: text }).then((applied) => applied && close())}
      />
    ) : null;

  return {
    buttons,
    strip,
    editor,
    onKey,
    canEdit: tools.includes("edit"),
    edit: () => run("edit"),
  };
}
