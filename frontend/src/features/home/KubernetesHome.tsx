import { kindView, type KubeView } from "../shell/workspace";
import type { TabNav } from "../shell/browserHistory";
export function KubernetesHome({nav}:{nav:TabNav<KubeView>}) { return <div style={{padding:32}}><h1>Where do you want to look?</h1><button onClick={()=>nav.navigate(v=>kindView(v,"pods",null),"push")}>Open pods</button></div>; }
