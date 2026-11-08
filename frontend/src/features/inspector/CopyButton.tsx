import { useEffect, useRef, useState } from "react";

const SAID_FOR_MS = 1_500;

/**
 * "Copy", then "Copied" for a moment. The text goes to the clipboard only: never logged or stored.
 * A browser that refuses the clipboard is said in words, on the button's title.
 */
export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const say = (next: "copied" | "failed") => {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), SAID_FOR_MS);
  };
  const copy = () => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) return say("failed");
    clipboard.writeText(text).then(() => say("copied"), () => say("failed"));
  };

  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      title={state === "failed" ? "The browser didn't allow the clipboard. Select the text and copy it instead." : undefined}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}</span>
    </button>
  );
}
