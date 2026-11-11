import type { StatusClass } from "../../api/types";
import s from "./Status.module.css";

const SHAPE: Record<StatusClass, "dot" | "ring" | "diamond"> = {
  ok: "dot",
  done: "dot",
  warn: "ring",
  bad: "diamond",
};

export function Status({ label, cls, showShape = true }: { label: string; cls: StatusClass; showShape?: boolean }) {
  return (
    <span className={`${s.st} ${s[cls]}`}>
      {showShape && <span className={s.shape} data-shape={SHAPE[cls]} aria-hidden="true" />}
      <span className={s.label}>{label}</span>
    </span>
  );
}
