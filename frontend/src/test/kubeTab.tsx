import { useState } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDock } from "../features/dock/useDock";
import { KubernetesTab } from "../features/kubernetes/KubernetesTab";
import type { KubeView } from "../features/shell/workspace";
import type { TabNav } from "../features/shell/browserHistory";
function Fixture({initial}:{initial:KubeView}) {
 const [view,setView]=useState(initial); const dock=useDock([]);
 const nav:TabNav<KubeView>={view,navigate:next=>setView(next),back:()=>{},forward:()=>{},canBack:false,canForward:false,setScroll:()=>{},scrollTop:0};
 return <KubernetesTab nav={nav} dock={dock} closed={[]} onReopen={()=>{}} loadProblem={null} onDismissLoadProblem={()=>{}} onEditPinned={()=>{}}/>;
}
export function renderKubeTab(view:KubeView) { return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture initial={view}/></QueryClientProvider>); }
