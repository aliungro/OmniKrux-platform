import { useMemo } from "react";
import s from "./YamlView.module.css";

/** The pod's manifest, read-only, with line numbers that stay out of a copy (editing arrives in Plan 3). */
export function YamlView({ yaml }: { yaml: string }) {
  const lines = useMemo(() => {
    const out = yaml.split("\n");
    if (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out;
  }, [yaml]);
  return (
    <pre className={`${s.yaml} mono`} data-testid="yaml" tabIndex={0} aria-label="Pod YAML">
      {lines.map((line, i) => (
        <span key={i} className={s.ln}>
          <span className={s.n} aria-hidden="true">{i + 1}</span>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
