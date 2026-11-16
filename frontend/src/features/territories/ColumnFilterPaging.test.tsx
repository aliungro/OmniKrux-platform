import { useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import type { Territory } from "./model";
const source=[{state:"ready",rows:Array.from({length:201},(_,i)=>({uid:String(i),name:String(i),columns:{node:`node-${String(i).padStart(3,"0")}`}}))}] as unknown as Territory[];
function Picker() {
 const [open,setOpen]=useState(false); const trigger=useRef<HTMLButtonElement>(null);
 return <><button ref={trigger} onClick={()=>setOpen(true)}>Open</button>{open && <ColumnFilterMenu col={{key:"node",label:"Node",type:"text",width:"m"}} source={source} onApply={()=>{}} onClose={()=>{setOpen(false);trigger.current?.focus();}} />}</>;
}
afterEach(cleanup);
it("keyboard selects values across pages, returns, and Escape restores focus", async()=>{
 const user=userEvent.setup(); render(<Picker/>); const trigger=screen.getByRole("button",{name:"Open"}); trigger.focus(); await user.keyboard("{Enter}");
 const first=screen.getByLabelText(/node-000/); first.focus(); await user.keyboard(" "); expect((first as HTMLInputElement).checked).toBe(true);
 screen.getByLabelText(/node-099/).focus(); await user.tab(); let next=screen.getByRole("button",{name:"Next values"}); expect(document.activeElement).toBe(next); await user.keyboard("{Enter}");
 let middle=screen.getByLabelText(/node-100/); expect(document.activeElement).toBe(middle); await user.keyboard(" "); expect((middle as HTMLInputElement).checked).toBe(true);
 screen.getByLabelText(/node-199/).focus(); await user.tab(); await user.tab(); next=screen.getByRole("button",{name:"Next values"}); expect(document.activeElement).toBe(next); await user.keyboard("{Enter}");
 const last=screen.getByLabelText(/node-200/); expect(document.activeElement).toBe(last); await user.keyboard(" "); expect((last as HTMLInputElement).checked).toBe(true);
 await user.tab(); let previous=screen.getByRole("button",{name:"Previous values"}); expect(document.activeElement).toBe(previous); await user.keyboard("{Enter}"); middle=screen.getByLabelText(/node-100/); expect(document.activeElement).toBe(middle); expect((middle as HTMLInputElement).checked).toBe(true);
 screen.getByLabelText(/node-199/).focus(); await user.tab(); previous=screen.getByRole("button",{name:"Previous values"}); expect(document.activeElement).toBe(previous); await user.keyboard("{Enter}"); expect(document.activeElement).toBe(screen.getByLabelText(/node-000/));
 await user.keyboard("{Escape}"); expect(document.activeElement).toBe(trigger);
});
