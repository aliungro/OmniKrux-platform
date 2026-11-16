import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { describe, it, expect, vi } from "vitest";
import { buildTerritories, NO_FILTER, POD_KIND } from "./model";
import { compileColumnFilters } from "./columnFilters";
import { applyMessage, emptyWatchState } from "../../api/watchState";
import type { Cluster, ResourceRow } from "../../api/types";
vi.mock("./columnFilters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./columnFilters")>();
  return { ...actual, compileColumnFilters: vi.fn(actual.compileColumnFilters) };
});
const cluster: Cluster = {id:"c",name:"c",context_name:"c",server:"",...FILE_CLUSTER_METADATA, original_server:null,provider:"kind",region:null,environment:"development",state:"ready",message:null};
const make = (i:number): ResourceRow => ({uid:String(i),cluster_id:"c",kind:"Pod",namespace:null,name:`pod-${i}`,created_at:"2026-11-09T11:00:30Z",labels:{},columns:{node:i%2 ? "a":"b"}});
const watch = (rows:ResourceRow[]) => applyMessage(emptyWatchState(),{type:"snapshot",cluster_id:"c",part:0,last:true,rows});
describe("territory filter cache and performance", () => {
 it.each(["within", "olderThan"] as const)("updates %s at the exact time within a minute", op => {
   const w=watch([make(1)]); const f={...NO_FILTER,columns:[{key:"age",op,seconds:3600}]};
   expect(buildTerritories([cluster],w,f,new Date("2026-11-09T12:00:20Z"),POD_KIND)[0].rows.length).toBe(op === "within" ? 1:0);
   expect(buildTerritories([cluster],w,f,new Date("2026-11-09T12:00:40Z"),POD_KIND)[0].rows.length).toBe(op === "within" ? 0:1);
 });
 it("keeps cache hits for time-independent filters within the minute", () => {
   const w=watch([make(1)]); const f={...NO_FILTER,columns:[{key:"node",op:"oneOf" as const,values:["a"]}]};
   expect(buildTerritories([cluster],w,f,new Date("2026-11-09T12:00:20Z"))[0]).toBe(buildTerritories([cluster],w,f,new Date("2026-11-09T12:00:40Z"))[0]);
 });
 it("compiles once per build over 10,000 rows across clusters", () => {
   const rows=Array.from({length:10000},(_,i)=>make(i)); const w=watch(rows); const f={...NO_FILTER,columns:[{key:"node",op:"oneOf" as const,values:["a"]}]};
   vi.mocked(compileColumnFilters).mockClear(); const start=performance.now(); const result=buildTerritories([cluster,{...cluster,id:"other"}],w,f,new Date());
   expect(result[0].rows).toHaveLength(5000); expect(compileColumnFilters).toHaveBeenCalledTimes(1); expect(performance.now()-start).toBeLessThan(1000);
 });
});
