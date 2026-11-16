import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import { identity, type Session } from "./dockState";
import { KIND_LABEL, SessionMarker, tagOf } from "./SessionMarker";
import s from "./SessionMenu.module.css";

const EDGE = 8; // the menu keeps this far from the window's edges
const GAP = 4; // between the button and the menu
const WIDTH = 340;
const ROOM = 180; // below this much room under the button, the menu opens above it if there is more there

/** Case-insensitive: the session's identity, its marker's word and its kind. */
function matches(x: Session, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return `${identity(x)} ${tagOf(x) ?? ""} ${KIND_LABEL[x.kind]}`.toLowerCase().includes(needle);
}

/** Under the button, right-aligned, kept 8 px inside the window; above it when there is more room there. */
function place(anchor: HTMLElement): CSSProperties {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.max(0, Math.min(WIDTH, vw - 2 * EDGE));
  const right = Math.min(Math.max(EDGE, vw - r.right), vw - EDGE - width);
  const below = vh - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  if (below < ROOM && above > below) return { right, width, bottom: vh - r.top + GAP, maxHeight: above };
  return { right, width, top: r.bottom + GAP, maxHeight: Math.max(below, 0) };
}

/**
 * Every open log and shell, with a search box: the "{n} open" popup under the dock's strip. It is
 * not modal; Esc or a click outside closes it (the strip puts the focus back on its button), and
 * leaving it with Tab closes it too.
 */
export function SessionMenu({
  id,
  anchor,
  sessions,
  focused,
  onPick,
  onClose,
}: {
  id: string;
  anchor: RefObject<HTMLElement | null>;
  sessions: Session[];
  focused: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  /** The option Enter picks; it stays put if its session closes meanwhile (picking it then says so by closing). */
  const [active, setActive] = useState<string | null>(focused ?? sessions[0]?.id ?? null);
  // Placed from the first frame: a hidden box could not take the focus.
  const [style, setStyle] = useState<CSSProperties>(() => (anchor.current ? place(anchor.current) : {}));
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const shown = sessions.filter((x) => matches(x, text));
  const optionId = (sessionId: string) => `${id}-option-${sessionId}`;
  const activeShown = shown.some((x) => x.id === active);

  useLayoutEffect(() => {
    const reposition = () => { if (anchor.current) setStyle(place(anchor.current)); };
    reposition();
    input.current?.focus();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [anchor]);

  // A press anywhere else closes it; the button toggles it itself.
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (root.current?.contains(target) || anchor.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor]);

  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  const onChange = (value: string) => {
    setText(value);
    const next = sessions.filter((x) => matches(x, value));
    if (!next.some((x) => x.id === active)) setActive(next[0]?.id ?? null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      // Only the menu: never the log behind it, nor the dock's way back to the table.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const at = shown.findIndex((x) => x.id === active);
      const n = shown.length;
      const next = e.key === "ArrowDown" ? (at + 1) % n : at < 0 ? n - 1 : (at + n - 1) % n;
      setActive(shown[next].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) onPick(active);
    }
  };

  const listId = `${id}-list`;
  return (
    <div
      ref={root}
      id={id}
      role="dialog"
      aria-label="Open logs and shells"
      className={s.menu}
      style={style}
      // Clicks inside keep the keyboard in the search box.
      onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to instanceof Node && !e.currentTarget.contains(to) && !anchor.current?.contains(to)) onClose();
      }}
    >
      <input
        ref={input}
        className={s.find}
        type="text"
        role="combobox"
        aria-label="Find a log or shell"
        placeholder="Find a log or shell"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={activeShown && active ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
      />
      <div role="listbox" id={listId} aria-label="Open logs and shells" className={s.list}>
        {shown.map((x) => {
          const provider = knownProvider(x.cluster.provider);
          return (
            <div
              key={x.id}
              id={optionId(x.id)}
              role="option"
              aria-selected={x.id === focused}
              data-active={x.id === active ? "true" : undefined}
              title={identity(x)}
              className={`${s.option} ${pc[provider]}`}
              onClick={() => onPick(x.id)}
              onMouseMove={() => { if (x.id !== active) setActive(x.id); }}
            >
              <ProviderBadge provider={x.cluster.provider} />
              <SessionMarker session={x} />
              <span className={s.pod}>{x.pod}</span>
              <span className={s.ns}>{` · ${x.namespace}`}</span>
            </div>
          );
        })}
      </div>
      {shown.length === 0 && <p className={s.none}>{`Nothing matches "${text}".`}</p>}
    </div>
  );
}
