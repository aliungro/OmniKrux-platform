import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BAR, GROUPS, isEditable, keysOf, type Shortcut } from "./shortcuts";
import k from "./key.module.css";
import s from "./ShortcutBar.module.css";

function Keys({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key) => (
        <span key={key} className={k.k}>{key}</span>
      ))}
    </>
  );
}

function AllShortcuts({ applies, onClose }: { applies: (x: Shortcut) => boolean; onClose: () => void }) {
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
          {GROUPS.map(([group, rows]) => (
            <section key={group} className={s.group} aria-label={group}>
              <h3 className={s.groupTitle}>{group}</h3>
              <dl className={s.list}>
                {rows.filter(applies).map((x) => (
                  <Fragment key={x.id}>
                    <dt><Keys keys={x.keys} /></dt>
                    <dd>{x.label}</dd>
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

/** `kind`: the kind on screen; keys that act on pods only are left out elsewhere (Ruling R14). */
export function ShortcutBar({ kind = "pods" }: { kind?: string }) {
  const applies = (x: Shortcut) => !x.podsOnly || kind === "pods";
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!keysOf("help").includes(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
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
          {BAR.filter(applies).map((x) => (
            <li key={x.id} className={s.item}>
              <Keys keys={x.keys} /> {x.bar}
            </li>
          ))}
          <li className={s.item}>
            <button type="button" className={s.more} aria-haspopup="dialog" onClick={() => setOpen(true)}>
              <span className={k.k}>?</span> all shortcuts
            </button>
          </li>
        </ul>
      </nav>
      {open && <AllShortcuts applies={applies} onClose={() => setOpen(false)} />}
    </>
  );
}
