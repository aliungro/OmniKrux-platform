import { defaultWorkspace, HOME, kindView } from "../features/shell/workspace";
export function seedPodsWorkspace() {
 const ws=defaultWorkspace(); ws.kubernetes.tabs[0].view=kindView(HOME,"pods");
 localStorage.setItem("omnikrux.workspace",JSON.stringify(ws));
}
