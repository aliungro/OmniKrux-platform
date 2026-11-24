// Where the imported dashboards go: one of the projects or groups the export can go into, or (for a
// group export) a new group made with them. With nowhere to go, it points to setting up a project.
import { useId, type Ref } from "react";
import type { TreeOut } from "../api/types";
import type { OwnerKind } from "../dashboards/schema";
import type { NewGroupIn } from "./api";
import { NO_PROJECT, isNewGroup, type ReviewTarget } from "./importModel";
import s from "./ImportReview.module.css";

export interface TargetPickerProps {
  kinds: OwnerKind[];
  tree: TreeOut | undefined;
  value: ReviewTarget | null;
  onChange(next: ReviewTarget | null): void;
  /** A group export: "A new group…" with these defaults. Null otherwise. */
  newGroup: NewGroupIn | null;
  error?: string | null;
  groupError?: string | null;
  selectRef?: Ref<HTMLSelectElement>;
  groupNameRef?: Ref<HTMLInputElement>;
  onSetUp(): void;
  setUpRef?: Ref<HTMLButtonElement>;
}

const NEW = "new";

function encode(t: ReviewTarget | null): string {
  if (t === null) return "";
  return isNewGroup(t) ? NEW : `${t.kind}:${t.id}`;
}

export function TargetPicker({ kinds, tree, value, onChange, newGroup, error, groupError, selectRef, groupNameRef, onSetUp, setUpRef }: TargetPickerProps) {
  const ids = useId();
  const projects = kinds.includes("project") ? (tree?.projects ?? []) : [];
  const groups = kinds.includes("group") ? (tree?.groups ?? []) : [];
  if (tree && projects.length === 0 && groups.length === 0 && newGroup === null) {
    return (
      <div className={s.setUp}>
        <p>{NO_PROJECT}</p>
        <button ref={setUpRef} type="button" className={s.secondary} onClick={onSetUp}>Set up a project</button>
      </div>
    );
  }

  const pick = (raw: string) => {
    if (raw === "") return onChange(null);
    if (raw === NEW && newGroup) return onChange({ newGroup: { ...newGroup, project_ids: [...newGroup.project_ids] } });
    const [kind, id] = [raw.slice(0, raw.indexOf(":")), raw.slice(raw.indexOf(":") + 1)];
    onChange({ kind: kind as OwnerKind, id });
  };
  const making = isNewGroup(value) ? value.newGroup : null;
  const setGroup = (patch: Partial<NewGroupIn>) => { if (making) onChange({ newGroup: { ...making, ...patch } }); };
  const toggleProject = (id: string, on: boolean) => {
    if (!making) return;
    const chosen = new Set(making.project_ids);
    if (on) chosen.add(id);
    else chosen.delete(id);
    // In the tree's order, as the group lists them.
    setGroup({ project_ids: (tree?.projects ?? []).map((p) => p.id).filter((p) => chosen.has(p)) });
  };

  return (
    <div className={s.target}>
      <label className={s.fieldLabel} htmlFor={`${ids}-to`}>Goes to</label>
      <select id={`${ids}-to`} ref={selectRef} className={s.select} value={encode(value)} onChange={(e) => pick(e.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${ids}-e` : undefined}>
        {value === null && <option value="" disabled>Pick where they go</option>}
        {projects.length > 0 && (
          <optgroup label="Projects">
            {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
          </optgroup>
        )}
        {(groups.length > 0 || newGroup) && (
          <optgroup label="Groups">
            {groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
            {newGroup && <option value={NEW}>A new group…</option>}
          </optgroup>
        )}
      </select>
      {error && <p id={`${ids}-e`} className={s.fieldError}>{error}</p>}

      {making && (
        <div className={s.newGroup}>
          <div className={s.field}>
            <label htmlFor={`${ids}-name`} className={s.fieldLabel}>Group name</label>
            <input id={`${ids}-name`} ref={groupNameRef} className={s.input} type="text" autoComplete="off" value={making.name}
              aria-invalid={groupError ? true : undefined} aria-describedby={groupError ? `${ids}-ge` : undefined}
              onChange={(e) => setGroup({ name: e.target.value })} />
            {groupError && <p id={`${ids}-ge`} className={s.fieldError}>{groupError}</p>}
          </div>
          <fieldset className={s.projects}>
            <legend className={s.fieldLabel}>Projects</legend>
            {(tree?.projects ?? []).map((p) => (
              <label key={p.id} className={s.check}>
                <input type="checkbox" checked={making.project_ids.includes(p.id)} onChange={(e) => toggleProject(p.id, e.target.checked)} />
                {p.name}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
