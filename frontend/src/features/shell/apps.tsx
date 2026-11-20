import type { JSX } from "react";
import type { AppId } from "./workspace";
export interface AppDef { id: AppId; label: string; title: string; key: string; place: "top" | "bottom"; tabs: boolean; Icon: () => JSX.Element }
const Kube = () => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2 21 7v10l-9 5-9-5V7z M12 2v20M3 7l18 10M21 7 3 17" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
const Pulse = () => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M2 12h4l3-7 4 14 3-7h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>;
const Audit = () => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 3h14v18H5z M8 8h8M8 12h8M8 16h5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
const Settings = () => <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.5"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>;
export const APPS: readonly AppDef[] = [
  { id:"kubernetes",label:"Kubernetes",title:"Kubernetes",key:"1",place:"top",tabs:true,Icon:Kube },
  { id:"monitoring",label:"Monitoring",title:"Monitoring",key:"2",place:"top",tabs:true,Icon:Pulse },
  { id:"audit",label:"Audit",title:"Audit log",key:"8",place:"bottom",tabs:false,Icon:Audit },
  { id:"settings",label:"Settings",title:"Settings",key:"9",place:"bottom",tabs:false,Icon:Settings },
];
export function appForKey(e: KeyboardEvent): AppId | undefined { return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? APPS.find(a => e.code === `Digit${a.key}`)?.id : undefined; }
