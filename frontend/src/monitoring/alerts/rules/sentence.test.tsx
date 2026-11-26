import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { installFakeMonitoringApi } from "../../test/fakeMonitoringApi";
import type { CapabilityOut, DryRunIn, DryRunOut, Engine } from "../api";
import { DryRunLine, calmerThreshold, dryRunWords } from "./DryRunLine";
import { RuleSentence, seriesWordOf, type SentenceValue } from "./RuleSentence";
import { WhereItRuns } from "./WhereItRuns";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const start: SentenceValue = { of: "each", op: "above", threshold: 0.3, for: "5m", every: "1m" };

function withClient(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const dry = (over: Partial<DryRunOut> = {}): DryRunOut => ({
  start: 0, end: 21600, step: 60, fired: 0, firing_now: false, periods: [], projects: [], candidates: [], took_ms: 3, ...over,
});

const body = (over: Partial<DryRunIn> = {}): DryRunIn => ({
  scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: "s1" }, expr: "up", of: "each", op: "above",
  threshold: 0.3, for: "5m", every: "1m", suggest: true, ...over,
});

const dryRuns = (api: ReturnType<typeof installFakeMonitoringApi>) => api.requests.filter((r) => r.url.endsWith("/alerts/dry-run"));

describe("the rule sentence", () => {
  it("the sentence reads as the prototype and changes by keyboard", async () => {
    const user = userEvent.setup();
    const seen: SentenceValue[] = [];
    function Host() {
      const [value, setValue] = useState(start);
      return <RuleSentence idPrefix="t" value={value} seriesWord="route" unit="s" onChange={(v) => { seen.push(v); setValue(v); }} />;
    }
    render(<Host />);
    expect(screen.getByRole("group", { name: "Alert when any route is above 0.3 s for 5 min, checked every 1 min" })).toBeTruthy();
    for (const name of ["Which series", "Above or below", "Threshold", "For how long", "How often to check"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    expect((screen.getByLabelText("For how long") as HTMLSelectElement).selectedOptions[0].textContent).toBe("5 min");
    expect([...(screen.getByLabelText("For how long") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "right away", "1 min", "2 min", "5 min", "10 min", "15 min", "30 min", "1 h",
    ]);
    expect([...(screen.getByLabelText("How often to check") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["30 s", "1 min", "5 min"]);

    // Arrow keys change Above or below.
    await user.click(screen.getByRole("radio", { name: "above" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "below" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "below" }));
    expect(screen.getByRole("group", { name: "Alert when any route is below 0.3 s for 5 min, checked every 1 min" })).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "above" }).getAttribute("aria-checked")).toBe("true");

    // Only finite numbers: "abc" says so and keeps 0.3.
    const threshold = screen.getByLabelText("Threshold");
    await user.clear(threshold);
    await user.type(threshold, "abc");
    expect(screen.getByText("Use a number.")).toBeTruthy();
    expect(threshold.getAttribute("aria-invalid")).toBe("true");
    expect(seen.at(-1)!.threshold).toBe(0.3);
    // Too large to be finite: refused like any other text.
    await user.clear(threshold);
    await user.paste("1e400");
    expect(screen.getByText("Use a number.")).toBeTruthy();
    expect(seen.at(-1)!.threshold).toBe(0.3);
    await user.clear(threshold);
    await user.type(threshold, "0.45");
    expect(screen.queryByText("Use a number.")).toBeNull();
    expect(seen.at(-1)!.threshold).toBe(0.45);

    await user.selectOptions(screen.getByLabelText("For how long"), "right away");
    await user.selectOptions(screen.getByLabelText("Which series"), "the total");
    expect(screen.getByRole("group", { name: "Alert when the total is above 0.45 s right away, checked every 1 min" })).toBeTruthy();
  });

  it("the series word is the query's first by label", () => {
    expect(seriesWordOf("histogram_quantile(0.95, sum by (route, le) (rate(x[5m])))")).toBe("route");
    expect(seriesWordOf("sum(rate(x[5m]))")).toBe("series");
  });
});

describe("the dry run line", () => {
  it("the dry run runs once after typing stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const api = installFakeMonitoringApi({ dryRun: dry() });
    const { rerender } = render(withClient(<DryRunLine body={body({ expr: "u" })} />));
    expect(screen.getByRole("status").textContent).toBe("Checking the last 6 hours…");
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    rerender(withClient(<DryRunLine body={body({ expr: "up" })} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    rerender(withClient(<DryRunLine body={body({ expr: "up{}" })} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(dryRuns(api)).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Checking the last 6 hours…");
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Over the last 6 hours this would not have fired."));
    expect(dryRuns(api)).toHaveLength(1);
    expect(dryRuns(api)[0].body).toEqual(body({ expr: "up{}" }));
  });

  it("a newer rule never shows the older answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    installFakeMonitoringApi({ dryRun: dry() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (b: DryRunIn) => <QueryClientProvider client={client}><DryRunLine body={b} /></QueryClientProvider>;
    const { rerender } = render(wrap(body()));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Over the last 6 hours this would not have fired."));
    rerender(wrap(body({ threshold: 9 })));
    expect(screen.getByRole("status").textContent).toBe("Checking the last 6 hours…");
  });

  it("a group names each project it couldn't read, and advises nothing from part of the data", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const out = dry({
      fired: 0, candidates: [{ threshold: 0.8, fired: 0 }],
      projects: [
        { project_id: "p1", project_name: "prod-east", fired: 0, firing_now: false, periods: [], series: 2, error: null },
        { project_id: "p2", project_name: "prod-west", fired: 0, firing_now: false, periods: [], series: 0, error: { code: "unreachable", message: "Can't reach Prometheus west." } },
      ],
    });
    installFakeMonitoringApi({ dryRun: { ...out, fired: 4, periods: [{ start: 100, end: 400, ongoing: false }] } });
    render(withClient(<DryRunLine body={body({ scope: { kind: "group", id: "g1" }, source: { type: "prometheus", id: null } })} onAdvice={() => {}} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Over the last 6 hours this would have fired 4 times \(last .+\) \(across 1 project\)\.prod-west: Can't reach Prometheus west\.$/));
    expect(screen.queryByText(/That's often/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    expect(dryRunWords(dry(), body({ scope: { kind: "group", id: "g1" } }), 0)).toBe("Over the last 6 hours this would not have fired (across 0 projects).");
  });

  it("a condition that holds before its for has passed says when it fires", () => {
    expect(dryRunWords(dry({ holding_now: true }), body({ for: "10m" }), 0))
      .toBe("Over the last 6 hours this would not have fired. Its condition holds now; it fires after 10 min.");
    // Once it fires, it says so instead.
    expect(dryRunWords(dry({ firing_now: true, holding_now: false }), body(), 0)).toBe("Over the last 6 hours this would not have fired. It is firing now.");
  });

  it("a run that couldn't check says why", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    installFakeMonitoringApi({ dryRun: { status: 504, error: { code: "timeout", message: "The dry run took too long to replay. Narrow the query with a label, ask for fewer thresholds, or use a shorter window." } } });
    render(withClient(<DryRunLine body={body()} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(
      "Couldn't check the last 6 hours: The dry run took too long to replay. Narrow the query with a label, ask for fewer thresholds, or use a shorter window.",
    ));
  });

  it("advice offers a calmer threshold and Use applies it", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({
      dryRun: dry({
        fired: 5, periods: [{ start: 100, end: 200, ongoing: false }],
        candidates: [{ threshold: 0.5, fired: 3 }, { threshold: 0.8, fired: 1 }, { threshold: 1.2, fired: 0 }],
      }),
    });
    const results: (DryRunOut | null)[] = [];
    function Host() {
      const [value, setValue] = useState(start);
      return (
        <>
          <RuleSentence idPrefix="t" value={value} seriesWord="route" unit="s" onChange={setValue} />
          <DryRunLine body={body({ threshold: value.threshold })} onAdvice={(t) => setValue({ ...value, threshold: t })}
            onResult={(out) => results.push(out)} />
        </>
      );
    }
    render(withClient(<Host />));
    const use = await screen.findByRole("button", { name: "Use 0.8" }, { timeout: 3000 });
    expect(screen.getByText("That's often. At 0.8 it would have fired once.")).toBeTruthy();
    expect(results.at(-1)?.fired).toBe(5);
    await user.click(use);
    expect((screen.getByLabelText("Threshold") as HTMLInputElement).value).toBe("0.8");
    expect(results.at(-1)).toBeNull();
    await waitFor(() => expect(dryRuns(api).at(-1)?.body).toEqual(body({ threshold: 0.8 })), { timeout: 3000 });
  });

  it("the calmer threshold is the closest quiet one on the calmer side", () => {
    const out = dry({ candidates: [{ threshold: 0.5, fired: 3 }, { threshold: 1.2, fired: 0 }, { threshold: 0.8, fired: 1 }, { threshold: 0.1, fired: 0 }] });
    expect(calmerThreshold(out, "above", 0.3)).toEqual({ threshold: 0.8, fired: 1 });
    expect(calmerThreshold(out, "below", 0.3)).toEqual({ threshold: 0.1, fired: 0 });
    expect(calmerThreshold(dry({ candidates: [{ threshold: 2, fired: 2 }] }), "above", 1)).toBeNull();
  });
});

describe("where it runs", () => {
  const cap = (over: Partial<CapabilityOut>): CapabilityOut => ({
    project_id: "p1", project_name: "prod-east", source_id: "s1", source_name: "Prometheus", tool: null, reason: null, ...over,
  });

  it("the tool choice is disabled with the reason", async () => {
    const user = userEvent.setup();
    const picked: Engine[] = [];
    const { rerender } = render(
      <WhereItRuns engine="omnikrux" onChange={(e) => picked.push(e)}
        capabilities={[cap({ reason: "No Prometheus Operator runs in prod-east's cluster." })]} />,
    );
    const group = screen.getByRole("radiogroup", { name: "Where it runs" });
    expect(group).toBeTruthy();
    const tool = screen.getByRole("radio", { name: "In the tool" }) as HTMLInputElement;
    expect(tool.disabled).toBe(true);
    expect(tool.getAttribute("aria-describedby") && document.getElementById(tool.getAttribute("aria-describedby")!)!.textContent)
      .toBe("No Prometheus Operator runs in prod-east's cluster.");
    expect(screen.getByText("Needs OmniKrux running. Works with any source.")).toBeTruthy();
    await user.click(tool);
    expect(picked).toEqual([]);

    rerender(
      <WhereItRuns engine="tool" onChange={(e) => picked.push(e)} capabilities={[
        cap({ tool: "prometheus_rule" }),
        cap({ project_id: "p2", project_name: "lab", tool: null, reason: "Its Prometheus can't be reached." }),
        cap({ project_id: "p3", project_name: "logs", source_name: "Logs", tool: "loki_ruler" }),
      ]} />,
    );
    expect((screen.getByRole("radio", { name: "In the tool" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText("In Prometheus: fires even when OmniKrux is off.")).toBeTruthy();
    expect(screen.getByText("lab: checked by OmniKrux instead. Its Prometheus can't be reached.")).toBeTruthy();
    expect(screen.getByText("In Logs: fires even when OmniKrux is off.")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Checked by OmniKrux" }));
    expect(picked).toEqual(["omnikrux"]);
  });
});
