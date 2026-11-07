import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import k from "./key.module.css";
import s from "./ShortcutBar.module.css";

/** The k9s-style strip along the bottom: the keys you'll use most. */
const BAR: [keys: string[], label: string][] = [
  [["↑", "↓"], "move"],
  [["Enter"], "details"],
  [["l"], "logs"],
  [["p"], "previous logs"],
  [["s"], "shell"],
  [["Ctrl F"], "search logs"],
  [["Ctrl \\"], "layout"],
  [["/"], "filter"],
];

/** Every shortcut, by where it works. */
const ALL: [group: string, rows: [keys: string[], label: string][]][] = [
  [
    "Pods",
    [
      [["↑", "↓"], "Move between pods"],
      [["Enter"], "Open or close the pod's details"],
      [["Esc"], "Close the details"],
      [["/"], "Filter pods"],
      [["l"], "Logs for the selected pod"],
      [["p"], "Previous logs (the run before the last restart)"],
      [["s"], "Shell in the selected pod"],
    ],
  ],
  [
    "Logs",
    [
      [["Ctrl F"], "Search logs"],
      [["Enter"], "Next match"],
      [["Shift", "Enter"], "Previous match"],
      [["G"], "Jump to live"],
    ],
  ],
  [
    "Dock",
    [
      [["Ctrl \\"], "Switch between one pane and side by side"],
      [["←", "→"], "Move between session tabs"],
      [["?"], "Show all shortcuts"],
    ],
  ],
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key) => (
        <span key={key} className={k.k}>{key}</span>
      ))}
    </>
  );
}

/** Keys typed into a field (or a terminal) belong to it. */
function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function AllShortcuts({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      onClose();
    }
    if (e.key === "Tab") e.preventDefault(); // one button: focus stays on it
  };
  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="All shortcuts" className={s.sheet} onKeyDown={onKey}>
        <div className={s.sheetHead}>
          <h2 className={s.title}>Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className={s.close} onClick={onClose}>
            Close<span className={k.k} aria-hidden="true">Esc</span>
          </button>
        </div>
        <div className={s.groups}>
          {ALL.map(([group, rows]) => (
            <section key={group} className={s.group} aria-label={group}>
              <h3 className={s.groupTitle}>{group}</h3>
              <dl className={s.list}>
                {rows.map(([keys, label]) => (
                  <Fragment key={label}>
                    <dt><Keys keys={keys} /></dt>
                    <dd>{label}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ShortcutBar() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <nav className={s.keys} aria-label="Keyboard shortcuts">
        <ul className={s.strip}>
          {BAR.map(([keys, label]) => (
            <li key={label} className={s.item}>
              <Keys keys={keys} /> {label}
            </li>
          ))}
          <li className={s.item}>
            <button type="button" className={s.more} aria-haspopup="dialog" onClick={() => setOpen(true)}>
              <span className={k.k}>?</span> all shortcuts
            </button>
          </li>
        </ul>
      </nav>
      {open && <AllShortcuts onClose={() => setOpen(false)} />}
    </>
  );
}
