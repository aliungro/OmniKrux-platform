import { APPS } from "./apps";
import type { AppId } from "./workspace";
import s from "./Rail.module.css";
export function Rail({app,onSelect}:{app:AppId;onSelect:(app:AppId)=>void}) {
 return <nav className={s.rail} aria-label="Apps" data-page-keys><div className={s.mark} aria-label="Omnikrux"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18M3 12h18"/></svg></div>{APPS.map(({id,title,label,key,Icon,place}) => <button key={id} className={`${s.item} ${place === "bottom" && id === "audit" ? s.bottom : ""}`} aria-label={title} aria-current={app===id?"page":undefined} aria-keyshortcuts={`Alt+${key}`} onClick={()=>onSelect(id)}><Icon/><span>{label}</span><span className={s.tip}>{title} <kbd>Alt {key}</kbd></span></button>)}</nav>;
}
