import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { useMemo, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildTerritories, NO_FILTER, type Filters } from "./model";
import { Table } from "../../test/table";
import { PODS, EVENTS } from "../../test/kinds";
import { applyMessage, emptyWatchState } from "../../api/watchState";
import type { Cluster, KindInfo, ResourceRow } from "../../api/types";
import { FilterBar } from "../chrome/FilterBar";
import { filterUiFor } from "./columnFilters";
const cluster: Cluster = {id:"c",name:"cluster",context_name:"c",server:"",...FILE_CLUSTER_METADATA, original_server:null,provider:"kind",region:null,environment:"development",state:"ready",message:null};
const row = (name:string, columns:Record<string,unknown>):ResourceRow => ({uid:name,cluster_id:"c",kind:"Pod",namespace:"n",name,created_at:null,columns,labels:{}});
const now = new Date("2026-11-09T12:00:00Z");
function Harness({kind,rows}:{kind:KindInfo;rows:ResourceRow[]}) {
 const [filters,setFilters]=useState<Filters>(NO_FILTER);
 const watch=useMemo(()=>applyMessage(applyMessage(emptyWatchState(),{type:"snapshot",cluster_id:"c",part:0,last:true,rows}),{type:"cluster_status",cluster_id:"c",state:"ready",message:null}),[rows]);
 const all=useMemo(()=>buildTerritories([cluster],watch,NO_FILTER,now,kind),[watch,kind]);
 const shown=buildTerritories([cluster],watch,filters,now,kind);
 return <><FilterBar value={filters} onChange={setFilters} chips={[]} counts={{}} namespaces={null} columns={kind.columns} pickSource={all}/><Table territories={shown} kind={kind} pickSource={all} columnFilters={filters.columns} sort={filters.sort} onColumnFilter={(key,f)=>setFilters(prev=>({...prev,columns:[...prev.columns.filter(x=>x.key!==key),...(f?[f]:[])]}))} onSort={sort=>setFilters(prev=>({...prev,sort}))} onRetry={()=>{}} /></>;
}
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function dimensions() {
 vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(600); vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(1200);
 vi.spyOn(HTMLElement.prototype,"offsetHeight","get").mockReturnValue(600); vi.spyOn(HTMLElement.prototype,"offsetWidth","get").mockReturnValue(1200);
 vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({x:0,y:0,top:0,left:0,right:1200,bottom:600,width:1200,height:600,toJSON:()=>({})} as DOMRect);
}
it("node pick and restart bounds filter visible rows, and Clear restores them", async()=>{
 dimensions(); const user=userEvent.setup(); const rows=[row("alpha",{node:"worker-a",restarts:1}),row("beta",{node:"worker-b",restarts:4})]; render(<Harness kind={PODS} rows={rows}/>);
 expect(screen.getByText("alpha")).toBeTruthy(); expect(screen.getByText("beta")).toBeTruthy();
 const node=screen.getByRole("button",{name:"Filter by Node"}); await user.click(node); await user.click(screen.getByLabelText(/worker-a/)); await user.click(screen.getByRole("button",{name:"Apply"}));
 expect(screen.getByText("alpha")).toBeTruthy(); expect(screen.queryByText("beta")).toBeNull();
 await user.click(node); await user.click(screen.getByRole("button",{name:"Clear"})); expect(screen.getByText("beta")).toBeTruthy(); expect(document.activeElement).toBe(node);
 const restarts=screen.getByRole("button",{name:"Filter by Restarts"}); await user.click(restarts); await user.type(screen.getByLabelText("Min"),"2"); await user.click(screen.getByRole("button",{name:"Apply"}));
 expect(screen.queryByText("alpha")).toBeNull(); expect(screen.getByText("beta")).toBeTruthy();
 await user.click(restarts); await user.keyboard("{Escape}"); expect(document.activeElement).toBe(restarts);
});
it("Events last seen within one hour filters visible rows", async()=>{
 dimensions(); const user=userEvent.setup(); const rows=[row("recent",{last_seen:"2026-11-09T11:30:00Z"}),row("old",{last_seen:"2026-11-09T10:00:00Z"})]; render(<Harness kind={EVENTS} rows={rows}/>);
 await user.click(screen.getByRole("button",{name:"Filter by Last seen"})); await user.click(screen.getByRole("button",{name:"Apply"}));
 expect(document.querySelector('[data-row-key="c/recent"]')).toBeTruthy(); expect(document.querySelector('[data-row-key="c/old"]')).toBeNull();
});
it("keyboard opens every filterable column from Add filter and Escape restores focus", async()=>{
 const user=userEvent.setup(); render(<Harness kind={PODS} rows={[]}/>);
 const add=screen.getByRole("button",{name:"Add filter"});
 for(const col of PODS.columns.filter(filterUiFor)) {
   add.focus(); await user.keyboard("{Enter}");
   const option=within(screen.getByRole("group",{name:"Filter rows"})).getByRole("button",{name:col.label});
   while(document.activeElement !== option) await user.tab();
   await user.keyboard("{Enter}"); expect(screen.getByRole("dialog",{name:`Filter by ${col.label}`})).toBeTruthy();
   await user.keyboard("{Escape}"); expect(document.activeElement).toBe(add);
 }
});

it("clicking elsewhere dismisses both stages of Add filter without applying a draft", async () => {
 const user = userEvent.setup();
 render(<Harness kind={PODS} rows={[]}/>);
 const bar = within(screen.getByRole("group", { name: "Filter rows" }));
 const add = bar.getByRole("button", { name: "Add filter" });
 const search = bar.getByRole("textbox", { name: "Filter by name, label or image" });
 await user.click(add);
 expect(add.getAttribute("aria-expanded")).toBe("true");
 await user.click(search);
 expect(add.getAttribute("aria-expanded")).toBe("false");
 expect(document.activeElement).toBe(search);

 await user.click(add);
 await user.click(bar.getByRole("button", { name: "Restarts" }));
 const dialog = screen.getByRole("dialog", { name: "Filter by Restarts" });
 await user.type(within(dialog).getByLabelText("Min"), "3");
 await user.click(search);
 expect(screen.queryByRole("dialog", { name: "Filter by Restarts" })).toBeNull();
 expect(bar.queryByRole("button", { name: /Remove filter/ })).toBeNull();
});
