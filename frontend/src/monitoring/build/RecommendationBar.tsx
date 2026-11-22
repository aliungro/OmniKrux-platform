// One recommendation for a panel (D1): what the data suggests, with Apply and a dismiss. It shows at
// most one (the first rule's whose key was not dismissed here), re-evaluates when the panel or its
// data changes, and never returns once dismissed for this scope. Apply hands the rewritten panel to
// `onApply`, which makes it a normal draft edit (or answers with why it was refused).

import { useMemo, useState } from "react";
import { dismiss, readDismissed } from "./dismissals";
import { recommendFor, type RecommendationContext, type RecText } from "./recommend";
import s from "./RecommendationBar.module.css";

export interface RecommendationBarProps {
  context: RecommendationContext;
  /** A dashboard id, or `explore:{project id}`: where a dismissal is kept. */
  scope: string;
  /** Takes the rewritten panel. A returned string is a refusal: it is said here and the bar stays. */
  onApply(next: RecommendationContext["panel"]): string | void;
  /** After Apply or Dismiss: the keyboard goes somewhere that stays (never `<body>`). */
  onDone?(): void;
}

const Text = ({ text }: { text: RecText }) => (
  <>
    {text.map((part, i) => (typeof part === "string" ? <span key={i}>{part}</span> : <strong key={i}>{part.strong}</strong>))}
  </>
);

export function RecommendationBar({ context, scope, onApply, onDone }: RecommendationBarProps) {
  const [gone, setGone] = useState(0);
  const [refusal, setRefusal] = useState<{ text: string; seq: number } | null>(null);
  const { panel, data, catalog, stepSeconds, alert } = context;
  const rec = useMemo(
    () => recommendFor({ panel, data, catalog, stepSeconds, alert }, readDismissed(scope)),
    // `gone` re-reads the dismissals after one is stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panel, data, catalog, stepSeconds, alert, scope, gone],
  );

  if (!rec) return null;

  const apply = () => {
    const refused = onApply(rec.apply(panel));
    if (typeof refused === "string") {
      setRefusal((was) => ({ text: refused, seq: (was?.seq ?? 0) + 1 }));
      return;
    }
    setRefusal(null);
    onDone?.();
  };
  const dismissIt = () => {
    dismiss(scope, rec.key);
    setRefusal(null);
    setGone((n) => n + 1);
    onDone?.();
  };

  return (
    <section className={s.wrap} aria-label="Recommendation">
      <div className={s.rec}>
        <span className={s.icon} aria-hidden="true">💡</span>
        <p className={s.text}><Text text={rec.text} /></p>
        <button type="button" className={s.apply} onClick={apply}>Apply</button>
        <button type="button" className={s.x} aria-label="Dismiss this recommendation" onClick={dismissIt}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <p className={s.refused} role="status" aria-live="polite">
        {refusal && <span key={refusal.seq}>{refusal.text}</span>}
      </p>
    </section>
  );
}
