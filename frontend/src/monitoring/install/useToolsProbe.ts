// Waiting for tools to answer at the addresses a generated file gave them: one probe every 5 s
// (the next only after the last answered, so none overlap), until every tool answers, the user
// stops, 15 minutes pass, or the page closes. The request in flight is aborted on every ending.
// Honest state only: a tool is "answering" only when a probe said so; a probe that failed to run
// changes nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { probeTools, type ProbeResultOut, type ToolType } from "./api";

export const PROBE_EVERY_MS = 5000;
export const GIVE_UP_AFTER_MS = 15 * 60 * 1000;

export interface ToolsProbe {
  results: ProbeResultOut[];
  waiting: boolean;
  gaveUp: boolean;
  /** Starts again from nothing, with a fresh 15 minutes. */
  again(): void;
  /** Stops asking; what was answered so far stays. */
  stop(): void;
}

interface State {
  results: ProbeResultOut[];
  waiting: boolean;
  gaveUp: boolean;
}

const IDLE: State = { results: [], waiting: false, gaveUp: false };

/** Whether every tool asked about answered. */
export const allAnswer = (results: ProbeResultOut[], count: number): boolean => count > 0 && results.length === count && results.every((r) => r.ok);

export function useToolsProbe(urls: Partial<Record<ToolType, string>> | null, opts: { interval?: number; giveUpAfter?: number } = {}): ToolsProbe {
  const interval = opts.interval ?? PROBE_EVERY_MS;
  const giveUpAfter = opts.giveUpAfter ?? GIVE_UP_AFTER_MS;
  const key = urls === null ? null : JSON.stringify(Object.entries(urls).filter(([, u]) => typeof u === "string" && u !== "").sort());
  const [round, setRound] = useState(0);
  const [state, setState] = useState<State>(IDLE);
  const end = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (key === null) {
      setState(IDLE);
      return;
    }
    const tools = (JSON.parse(key) as [ToolType, string][]).map(([type, url]) => ({ type, url }));
    if (tools.length === 0) {
      setState(IDLE);
      return;
    }
    let over = false;
    let timer: number | undefined;
    let ctrl: AbortController | null = null;
    const finish = () => {
      over = true;
      window.clearTimeout(timer);
      window.clearTimeout(giveUp);
      ctrl?.abort();
    };
    const giveUp = window.setTimeout(() => {
      if (over) return;
      finish();
      setState((s) => ({ ...s, waiting: false, gaveUp: true }));
    }, giveUpAfter);
    end.current = finish;
    setState({ results: [], waiting: true, gaveUp: false });

    const ask = async () => {
      ctrl = new AbortController();
      try {
        const out = await probeTools({ tools }, ctrl.signal);
        if (over) return;
        if (allAnswer(out.results, tools.length)) {
          finish();
          setState({ results: out.results, waiting: false, gaveUp: false });
          return;
        }
        setState((s) => ({ ...s, results: out.results }));
      } catch {
        if (over) return; // couldn't ask this time: nothing changes, ask again
      }
      timer = window.setTimeout(() => void ask(), interval);
    };
    void ask();
    return () => {
      finish();
      if (end.current === finish) end.current = null;
    };
  }, [key, round, interval, giveUpAfter]);

  const stop = useCallback(() => {
    end.current?.();
    end.current = null;
    setState((s) => ({ ...s, waiting: false }));
  }, []);
  const again = useCallback(() => setRound((n) => n + 1), []);
  return { ...state, again, stop };
}
