import type { ContainerState } from "../../api/types";
import s from "./ContainerBullets.module.css";

/** The columns payload is untyped: reject malformed lists rather than inventing state. */
export function isContainerStates(value: unknown): value is ContainerState[] {
  return Array.isArray(value) && value.every((c: unknown) => {
    if (typeof c !== "object" || c === null) return false;
    const item = c as Record<string, unknown>;
    return typeof item.name === "string" && typeof item.init === "boolean"
      && ["ready", "running", "waiting", "failing", "done"].includes(item.state as string)
      && (item.reason === null || typeof item.reason === "string")
      && typeof item.restarts === "number" && Number.isInteger(item.restarts) && item.restarts >= 0;
  });
}

function title(c: ContainerState): string {
  const who = c.init ? `init ${c.name}` : c.name;
  const restarts = `${c.restarts} ${c.restarts === 1 ? "restart" : "restarts"}`;
  switch (c.state) {
    case "ready": return `${who}: running and ready · ${restarts}`;
    case "running": return `${who}: running, not ready · ${restarts}`;
    case "waiting": return `${who}: waiting${c.reason ? ` (${c.reason})` : ""} · ${restarts}`;
    case "failing": return `${who}: failing (${c.reason ?? ""}) · ${restarts}`;
    case "done": return `${who}: finished (${c.reason ?? ""})`;
  }
}

export function ContainerBullets({ containers }: { containers: ContainerState[] }) {
  if (containers.length === 0) return null;
  const counts = { ready: 0, "not ready": 0, failing: 0, finished: 0 };
  for (const c of containers) {
    const key = c.state === "done" ? "finished" : c.state === "running" || c.state === "waiting" ? "not ready" : c.state;
    counts[key]++;
  }
  const label = Object.entries(counts).filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`).join(", ");
  return (
    <span className={s.group} role="img" aria-label={`Containers: ${label}`}>
      {containers.slice(0, 6).map((c, i) => (
        <span key={i} className={`${s.bullet} ${s[c.state]}`} title={title(c)}
          data-shape={c.state === "failing" ? "diamond" : c.state === "done" ? "ring" : "dot"} />
      ))}
      {containers.length > 6 && <span className={s.more} title={containers.slice(6).map(title).join("\n")}>+{containers.length - 6}</span>}
    </span>
  );
}
