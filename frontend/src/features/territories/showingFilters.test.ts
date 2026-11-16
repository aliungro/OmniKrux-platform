import { it, expect, vi } from "vitest";
import { showingFilters, NO_FILTER, POD_KIND } from "./model";
import { compileColumnFilters } from "./columnFilters";
import type { ResourceRow } from "../../api/types";
vi.mock("./columnFilters", async (original) => { const actual = await original<typeof import("./columnFilters")>(); return {...actual, compileColumnFilters: vi.fn(actual.compileColumnFilters)}; });
it("checks all landing filters with one compilation", () => {
 const row: ResourceRow = {uid:"1",cluster_id:"c",kind:"Pod",namespace:"n",name:"web",created_at:null,labels:{},columns:{node:"worker",restarts:1}};
 const f = {...NO_FILTER, columns:[{key:"node",op:"oneOf" as const,values:["worker"]},{key:"restarts",op:"between" as const,min:2,max:null}]};
 vi.mocked(compileColumnFilters).mockClear();
 expect(showingFilters(row,f,POD_KIND,new Date()).columns).toEqual([f.columns[0]]);
 expect(compileColumnFilters).toHaveBeenCalledTimes(1);
});
