import { createContext } from "react";
import type { ScopeCluster } from "../chrome/TopBar";
import type { PaletteSelection } from "../palette/CommandPalette";
import type { RowAction } from "../actions/tools";
export interface PaletteTarget { selection:PaletteSelection|null; onKind:(key:string)=>void; onRowAction:(action:RowAction)=>void }
export const ShellBridge=createContext<{setScope:(scope:ScopeCluster[]|null)=>void;setPaletteTarget:(target:PaletteTarget|null)=>void}>({setScope:()=>{},setPaletteTarget:()=>{}});
