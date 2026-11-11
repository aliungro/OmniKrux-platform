import type { ComponentPropsWithRef } from "react";
import s from "./ResourceRowView.module.css";

/** Native checkbox semantics with the same mark in the header and every resource row. */
export function SelectionCheckbox(props: Omit<ComponentPropsWithRef<"input">, "type">) {
  return (
    <span className={s.checkbox}>
      <input {...props} type="checkbox" />
      <span className={s.checkboxMark} aria-hidden="true" />
    </span>
  );
}
