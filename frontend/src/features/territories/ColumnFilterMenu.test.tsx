import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import { pickValues, validColumnFilter } from "./columnFilters";
import type { Territory } from "./model";
vi.mock("./columnFilters", async (original) => { const actual=await original<typeof import("./columnFilters")>(); return {...actual,pickValues:vi.fn(actual.pickValues)}; });
afterEach(cleanup);
it("memoizes pick counts while searching and limits selection to storable values", () => {
 const values=Array.from({length:201},(_,i)=>`node-${String(i).padStart(3,"0")}`);
 const source=[{state:"ready",rows:values.map((v,i)=>({uid:String(i),name:v,columns:{node:v}}))}] as unknown as Territory[];
 const filter={key:"node",op:"oneOf" as const,values:values.slice(0,200)}; const apply=vi.fn();
 vi.mocked(pickValues).mockClear(); render(<ColumnFilterMenu col={{key:"node",label:"Node",type:"text",width:"m"}} filter={filter} source={source} onApply={apply} onClose={()=>{}} />);
 fireEvent.change(screen.getByPlaceholderText("Find a value"),{target:{value:"node-200"}});
 expect(vi.mocked(pickValues)).toHaveBeenCalledTimes(1);
 expect((screen.getByLabelText(/node-200/) as HTMLInputElement).disabled).toBe(true);
 expect(screen.getByText("Select up to 200 values.")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Apply"})); expect(validColumnFilter(apply.mock.lastCall?.[0])).toEqual(filter);
});
