import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { failure } from "../../api/http";
import type { ActionName, ResourceRow } from "../../api/types";
import { ScaleForm, RollbackForm } from "../actions/forms";
import { keyedTools, toolsFor, TOOL_LABEL, type ToolId } from "../actions/tools";
import { useStartAction, type ActionOutcome } from "../actions/useActions";
import { YamlEditor } from "../actions/YamlEditor";
import { capsOf, isEditable, toolShortcut } from "../chrome/shortcuts";
import { ForwardDialog } from "../portforward/ForwardDialog";
import { textColumn } from "../territories/model";
import k from "../chrome/key.module.css";
import s from "./Inspector.module.css";

/**
 * A key press on the row (or a palette command) that asks the details for something: a change tool,
 * or one of the inspector's own (the YAML tab, a workload's pods' logs, a Secret's keys). `seq`
 * tells two apart.
 */
export interface ToolIntent {
  tool: ToolId | ViewIntent;
  seq: number;
  /** For `tool: "tab"`: the detail tab to show, 1-based. */
  tab?: number;
}

/** What a row's key asks of the details themselves rather than of a change tool. */
export type ViewIntent = "yaml" | "workloadLogs" | "reveal" | "tab";
const VIEW_INTENTS: ReadonlySet<string> = new Set<ViewIntent>(["yaml", "workloadLogs", "reveal", "tab"]);

/** The count a workload runs at, from its row's Ready column ("2/3" → 3); 1 when it can't tell. */
export function desiredReplicas(row: ResourceRow): number {
  const ready = textColumn(row, "ready");
  const desired = ready?.split("/")[1];
  return desired !== undefined && /^\d+$/.test(desired) ? Number(desired) : 1;
}

/**
 * The change tools of one object's details: the buttons (with their keys), the inline forms (scale,
 * rollback), the YAML editor, and a line under the tab bar saying why a plan couldn't be made or
 * what an applied change did (kept until you start another tool or leave the row). A change is
 * planned through the actions provider, which opens the review dialog on the plan; a plan that
 * comes back after these details went, or moved to another object, never opens.
 */
export function useTools({
  row,
  kindKey,
  verbs,
  onNodeShell,
  onEditing,
  intent,
  onIntentDone,
  paneActive = true,
}: {
  row: ResourceRow;
  kindKey: string;
  verbs: readonly string[];
  onNodeShell?: (row: ResourceRow, node: string) => void;
  /** Editing starts: show the YAML tab. */
  onEditing: () => void;
  intent?: ToolIntent | null;
  onIntentDone?: () => void;
  paneActive?: boolean;
}) {
  const start = useStartAction();
  // Port-forwards need no plan, so they don't wait for the actions provider.
  const tools = toolsFor(kindKey, verbs, row).filter((t) => start || t === "portForward");
  const [open, setOpen] = useState<"edit" | "scale" | "rollback" | "forward" | null>(null);
  const forwardGeneration = useRef(0);
  const [busy, setBusy] = useState<ToolId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const said = useRef<HTMLParagraphElement>(null);

  // A plan that returns after a pane loses focus must not open a dialog over the active pane.
  const identity = `${row.cluster_id}\n${kindKey}\n${row.uid}`;
  const generation = useRef(0);
  useLayoutEffect(() => {
    if (!paneActive) setBusy(null);
    return () => { generation.current += 1; };
  }, [identity, paneActive]);
  // Another object in the same details starts clean: no form, line or wait of the last one's.
  const [shownIdentity, setShownIdentity] = useState(identity);
  if (shownIdentity !== identity) {
    setShownIdentity(identity);
    setOpen(null);
    setBusy(null);
    setError(null);
    setOutcome(null);
  }

  /** Plans a change on this object; true when it was applied (and what it did is shown). */
  const request = async (tool: ToolId, action: ActionName, params: Record<string, unknown> = {}): Promise<boolean> => {
    if (!start || !paneActive) return false;
    const mine = generation.current;
    const current = () => generation.current === mine;
    setBusy(tool);
    setError(null);
    try {
      const target = { cluster_id: row.cluster_id, kind_key: kindKey, namespace: row.namespace, name: row.name };
      const done = await start({ action, target, params }, { isCurrent: current });
      if (done === null || !current()) return false;
      setOutcome(done);
      return true;
    } catch (err) {
      if (current()) setError(failure(err));
      return false;
    } finally {
      if (current()) setBusy(null);
    }
  };

  // What a change did takes focus only when focus was lost with the dialog or form that went (the
  // button that started it is gone): never pulled from wherever you have moved since.
  // Checked once the line is shown (a form closing after the apply shows it a render later).
  const focusedFor = useRef<ActionOutcome | null>(null);
  useEffect(() => {
    if (outcome === null || said.current === null || focusedFor.current === outcome) return;
    focusedFor.current = outcome;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) said.current.focus();
  }, [outcome, open]);

  const run = (tool: ToolId) => {
    if (!paneActive || busy !== null || !tools.includes(tool)) return;
    setError(null);
    setOutcome(null);
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
      case "portForward":
        forwardGeneration.current = generation.current;
        setOpen("forward");
        return;
      case "delete":
      case "evict":
        // Pin the row the user chose: a same-name replacement is refused at review (Plan 3 R28).
        setOpen(null);
        void request(tool, tool, { expected_uid: row.uid });
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
    if (!intent || VIEW_INTENTS.has(intent.tool)) return;
    runRef.current(intent.tool as ToolId);
    onIntentDone?.();
  }, [intent, onIntentDone]);

  const close = useCallback(() => {
    setOpen(null);
    setError(null);
  }, []);

  /**
   * Tool keys pressed inside the details (Ctrl+D and Ctrl+Del or Cmd+Backspace delete), never in a
   * field, the editor or a terminal. A held delete key reviews once.
   */
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    const id = toolShortcut(e, keyedTools(tools));
    if (id === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && id === "delete") return;
    run(id as ToolId);
  };

  const buttons: ReactNode = tools.map((tool) => {
    const caps = tool === "rollback" || tool === "evict" ? [] : capsOf(tool);
    return (
      <button
        key={tool}
        type="button"
        className={`${s.btn}${tool === "delete" || tool === "evict" ? ` ${s.danger}` : ""}`}
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

  // Under the tab bar: a scale or rollback form, why a change couldn't be planned, or what it did.
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
  } else if (outcome && open === null) {
    strip = (
      <p ref={said} className={s.outcome} data-tone={outcome.tone} role="status" tabIndex={-1}>
        {outcome.message}
      </p>
    );
  }

  // The port-forward dialog: a start that finishes after you moved to another object is not said here
  // (the forward itself is listed in the top bar either way).
  const dialog: ReactNode =
    open === "forward" && (kindKey === "pods" || kindKey === "services") ? (
      <ForwardDialog
        target={{
          clusterId: row.cluster_id,
          namespace: row.namespace ?? "",
          kind: kindKey === "pods" ? "pod" : "service",
          name: row.name,
          version: textColumn(row, "resource_version") ?? "",
        }}
        onCancel={close}
        onStarted={(forward) => {
          if (forwardGeneration.current !== generation.current) return;
          setOpen(null);
          setOutcome({
            message: `Forwarding localhost:${forward.local_port} to port ${forward.remote_port} of ${forward.kind} ${forward.name}. Stop it from the port-forwards menu at the top.`,
            tone: "ok",
          });
        }}
      />
    ) : null;

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
    strip: (
      <>
        {strip}
        {dialog}
      </>
    ),
    editor,
    onKey,
    canEdit: tools.includes("edit"),
    edit: () => run("edit"),
    /**
     * The YAML editor is open: nothing may switch away from the YAML tab by key (it is shown only
     * there, so the unsaved text would go with it). Ruling R36.
     */
    editing: open === "edit",
  };
}
