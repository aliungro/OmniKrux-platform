import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { allGroups, barFor, capsOf, pageKey, pressed, type ShortcutGroup } from "./shortcuts";
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

function AllShortcuts({ groups, onClose }: { groups: readonly ShortcutGroup[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || pressed("help", e)) {
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
          {groups.map(([group, rows]) => (
            <section key={group} className={s.group} aria-label={group}>
              <h3 className={s.groupTitle}>{group}</h3>
              <dl className={s.list}>
                {rows.map((x) => (
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

/**
 * The key strip along the bottom and the "?" sheet, both for the kind on screen: `s` reads "shell"
 * on pods and "scale" on deployments, as the registry says.
 */
export function ShortcutBar({ kind = "pods" }: { kind?: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pressed("help", e) || !pageKey(e)) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <nav className={s.keys} aria-label="Keyboard shortcuts" data-page-keys>
        <ul className={s.strip}>
          {barFor(kind).map((x) => (
            <li key={x.id} className={s.item}>
              <Keys keys={x.keys} /> {x.bar}
            </li>
          ))}
          <li className={s.item}>
            <button type="button" className={s.more} aria-haspopup="dialog" onClick={() => setOpen(true)}>
              <span className={k.k}>{capsOf("help")[0]}</span> all shortcuts
            </button>
          </li>
        </ul>
      </nav>
      {open && <AllShortcuts groups={allGroups(kind)} onClose={() => setOpen(false)} />}
    </>
  );
}
