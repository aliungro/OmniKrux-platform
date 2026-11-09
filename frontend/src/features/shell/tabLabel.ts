import type { Cluster, KindInfo } from "../../api/types";
import { fallbackKind, kindTitle } from "../territories/model";
import type { KubeView } from "./workspace";
export function tabLabel(view:KubeView, ctx:{kinds?:KindInfo[];clusters?:Cluster[]}):string {
 if(view.page==="home") return "Home";
 const title=kindTitle(ctx.kinds?.find(k=>k.key===view.kind) ?? fallbackKind(view.kind));
 if(view.clusters===null) return `${title} · all clusters`;
 if(view.clusters.length===1) return `${title} · ${ctx.clusters?.find(c=>c.id===view.clusters![0])?.name ?? view.clusters[0]}`;
 return `${title} · ${view.clusters.length} clusters`;
}
