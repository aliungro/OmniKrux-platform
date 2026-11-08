// TerritoryTable with its selection held the way Console holds it.
import { useState } from "react";
import { NO_SELECTION, type Selection } from "../features/territories/model";
import { TerritoryTable, type TerritoryTableProps } from "../features/territories/TerritoryTable";

export function Table(props: Omit<TerritoryTableProps, "selection" | "onSelection"> & { initial?: Selection }) {
  const { initial, ...rest } = props;
  const [selection, setSelection] = useState<Selection>(initial ?? NO_SELECTION);
  return <TerritoryTable selection={selection} onSelection={setSelection} {...rest} />;
}
