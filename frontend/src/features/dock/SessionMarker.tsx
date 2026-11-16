import { identity, type Session } from "./dockState";
import s from "./SessionTabs.module.css";

export const KIND_LABEL = { logs: "Logs", shell: "Shell" } as const;

/** What sets a session apart from a plain one: its marker on the tab, and a word in its name. */
export function tagOf(x: Session): string | null {
  if (x.follow) return "Follows row";
  if (x.pinned) return "Pinned";
  if (x.cleanupPod) return "Node";
  if (x.debug) return "Debug";
  if (x.selector) return "All pods";
  if (x.previous) return "Previous";
  return null;
}

/** A session's accessible name, on its tab and its "{n} open" option: "Logs Pinned: cluster / namespace / pod (container)". */
export function sessionName(x: Session): string {
  const tag = tagOf(x);
  return `${KIND_LABEL[x.kind]}${tag ? ` ${tag}` : ""}: ${identity(x)}`;
}

/**
 * The marker before a session's pod name, on its tab and in the "{n} open" menu: the follow log's
 * "◉ follows row" (grey while it holds its last pod), a pin, "Shell", or the session's tag.
 */
export function SessionMarker({ session: x }: { session: Session }) {
  if (x.follow) return <span className={`${s.follow}${x.hold ? ` ${s.held}` : ""}`}>◉ follows row</span>;
  if (x.pinned) return <span className={s.pin} aria-hidden="true">📌</span>;
  const tag = tagOf(x);
  return (
    <>
      {x.kind === "shell" && <span className={s.kind}>{KIND_LABEL.shell}</span>}
      {tag && <span className={s.tag}>{tag}</span>}
    </>
  );
}
