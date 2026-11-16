import { usePinnedKinds } from "./pinnedKinds";

/** Persistent write failures name each independent store and clear when that store saves again. */
export function StorageSaveNotices({ workspaceProblem, className }: { workspaceProblem: string | null; className: string }) {
  const pinned = usePinnedKinds();
  return <>
    {workspaceProblem && <p role="alert" className={className}>Tabs can't be saved in this browser ({workspaceProblem}). They last until you close this page.</p>}
    {pinned.saveProblem && <p role="alert" className={className}>Pinned kinds can't be saved in this browser ({pinned.saveProblem}). Your changes last until you close this page.</p>}
  </>;
}
