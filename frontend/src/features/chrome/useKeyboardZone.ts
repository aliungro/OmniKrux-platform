import { useEffect, useState } from "react";
import { keyboardZone } from "./pageKeys";
import type { KeyboardZone } from "./shortcuts";

/**
 * The keyboard zone that has the focus right now, for the outline and the shortcut strip.
 * `focusout` is read a frame later, once focus has landed; state is set only when the zone changes.
 */
export function useKeyboardZone(): KeyboardZone | null {
  const [zone, setZone] = useState<KeyboardZone | null>(() => keyboardZone(document.activeElement));
  useEffect(() => {
    let frame = 0;
    const read = () => setZone(keyboardZone(document.activeElement));
    const onOut = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", onOut);
    read();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return zone;
}
