import { useEffect, useRef } from "react";
import type { KindInfo } from "../../api/types";
import { PinnedKindsSection } from "./PinnedKindsSection";
import { usePinnedKinds } from "./pinnedKinds";
import s from "./SettingsView.module.css";

export function SettingsView({ kinds, saveProblem = null, section }: {
  kinds: readonly KindInfo[] | undefined;
  saveProblem?: string | null;
  section?: "pinned-kinds" | "this-browser";
}) {
  const root = useRef<HTMLDivElement>(null);
  const pinned = usePinnedKinds();
  const problem = saveProblem ?? pinned.saveProblem;
  useEffect(() => { if (section) root.current?.querySelector(`#${section}`)?.scrollIntoView?.({ block: "start" }); }, [section]);
  return <div className={s.viewport} ref={root}><div className={s.page}>
    <h1>Settings</h1>
    <PinnedKindsSection kinds={kinds}/>
    <section id="this-browser" aria-labelledby="browser-heading" className={s.section}>
      <h2 id="browser-heading">This browser</h2>
      <p className={s.lede}>Tabs and pinned kinds are saved in this browser only, not shared with anyone.</p>
      {pinned.loadProblem && <div role="alert" className={s.problem}>{pinned.loadProblem} <button type="button" aria-label="Dismiss pinned kinds notice" onClick={pinned.dismissLoadProblem}>Dismiss</button></div>}
      {problem && <p role="alert" className={s.problem}>Tabs can't be saved in this browser ({problem}). They last until you close this page.</p>}
    </section>
  </div></div>;
}
