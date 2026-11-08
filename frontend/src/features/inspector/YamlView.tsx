import { useMemo } from "react";
import { CopyButton } from "./CopyButton";
import s from "./YamlView.module.css";

/**
 * The object's manifest, read-only, with line numbers that stay out of a copy. "Copy" copies it as
 * the server sent it: for a Secret that is the masked YAML, never a value.
 */
export function YamlView({ yaml, label = "Pod YAML" }: { yaml: string; label?: string }) {
  const lines = useMemo(() => {
    const out = yaml.split("\n");
    if (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out;
  }, [yaml]);
  return (
    <div className={s.box}>
      <div className={s.tools}>
        <CopyButton text={yaml} className={s.btn} />
      </div>
      <pre className={`${s.yaml} mono`} data-testid="yaml" tabIndex={0} aria-label={label}>
        {lines.map((line, i) => (
          <span key={i} className={s.ln}>
            <span className={s.n} aria-hidden="true">{i + 1}</span>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
