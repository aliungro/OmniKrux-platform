import { describe, expect, it } from "vitest";
import type { ImportPreviewOut, PreviewDashboardOut, SourceRefOut } from "./api";
import {
  chosenCount, commitBody, initialReview, rebaseReview, sizeWords, skippedCount, summaryWords, titleProblem,
} from "./importModel";

const dash = (key: string, title: string, over: Partial<PreviewDashboardOut> = {}): PreviewDashboardOut => ({
  key, title, suggested_title: title, title_taken: false, panels: 3, alerts: 0, skipped: [], problems: [], importable: true, digest: `dg-${key}`, ...over,
});
const ref = (key: string, over: Partial<SourceRefOut> = {}): SourceRefOut => ({
  key, type: "prometheus", type_guessed: false, name: key, detail: null, suggestion: null, leave_out: false, reason: "Same name.", ...over,
});
const preview = (over: Partial<ImportPreviewOut> = {}): ImportPreviewOut => ({
  format: "grafana", format_label: "Grafana dashboard", target_kinds: ["project", "group"], suggested_target: null, bundle: null,
  sources: [], dashboards: [], skipped_total: 0, ...over,
});
const item = (what: string) => ({ where: 'Panel "CPU"', what, reason: "Not converted." });
const INPUT = { kind: "text", text: "{}", via: "paste" } as const;
const P1 = { kind: "project", id: "p1" } as const;

describe("the import review model", () => {
  it("initial review chooses importable dashboards with suggested titles", () => {
    const s = initialReview(preview({
      dashboards: [dash("a", "Overview", { suggested_title: "Overview (2)", title_taken: true }), dash("b", "Broken", { importable: false })],
      sources: [ref("prom", { suggestion: "s1" }), ref("logs", { type: "loki", leave_out: true })],
    }), P1);
    expect(s.chosen).toEqual({ a: { use: true, title: "Overview (2)" }, b: { use: false, title: "Broken" } });
    expect(s.mapping).toEqual({ prom: { key: "prom", source_id: "s1" }, logs: { key: "logs", leave_out: true } });
    expect(s.target).toEqual(P1);
    expect(chosenCount(s)).toBe(1);
  });

  it("commit body carries mapping, titles and digests", () => {
    const s = initialReview(preview({
      dashboards: [dash("a", "Overview"), dash("b", "Nodes"), dash("c", "Broken", { importable: false })],
      sources: [ref("prom", { suggestion: "s1" }), ref("other")],
    }), P1);
    s.chosen.a.title = "  Overview here ";
    s.chosen.b.use = false;
    s.mapping.other = { key: "other", leave_out: true };
    expect(commitBody(INPUT, s)).toEqual({
      input: INPUT, target: P1, new_group: null,
      mapping: [{ key: "prom", source_id: "s1" }, { key: "other", leave_out: true }],
      dashboards: [{ key: "a", title: "Overview here", digest: "dg-a" }],
    });
    // A group reads no source of its own: no mapping; a new group goes as `new_group`.
    s.target = { newGroup: { name: " Fleet ", project_ids: ["p1", "p2"] } };
    expect(commitBody(INPUT, s)).toMatchObject({ target: null, new_group: { name: "Fleet", project_ids: ["p1", "p2"] }, mapping: [] });
  });

  it("skipped count follows the chosen dashboards", () => {
    const s = initialReview(preview({
      dashboards: [dash("a", "A", { skipped: [item("Its unit"), item("Its links")] }), dash("b", "B", { skipped: [item("Its legend")] })],
    }), P1);
    expect(skippedCount(s)).toBe(3);
    expect(summaryWords(s)).toBe("2 of 2 dashboards chosen · 3 things won't be copied");
    s.chosen.a.use = false;
    expect(skippedCount(s)).toBe(1);
    expect(summaryWords(s)).toBe("1 of 2 dashboards chosen · 1 thing won't be copied");
    s.chosen.b.use = false;
    expect(summaryWords(s)).toBe("0 of 2 dashboards chosen · everything converts");
  });

  it("two chosen dashboards with one title is a title problem", () => {
    const s = initialReview(preview({ dashboards: [dash("a", "Overview"), dash("b", "Nodes")] }), P1);
    const none = new Set<string>();
    expect(titleProblem(s, "a", none)).toBeNull();
    s.chosen.b.title = "Overview ";
    expect(titleProblem(s, "a", none)).toBe('Another dashboard here is also called "Overview". Pick another name.');
    expect(titleProblem(s, "b", none)).toBe('Another dashboard here is also called "Overview". Pick another name.');
    // Not when the other one stays out.
    s.chosen.b.use = false;
    expect(titleProblem(s, "a", none)).toBeNull();
    expect(titleProblem(s, "a", new Set(["Overview"]), "shop")).toBe('A dashboard named "Overview" already exists in shop. Pick another name.');
    s.chosen.a.title = "  ";
    expect(titleProblem(s, "a", none)).toBe("Give this dashboard a title.");
    s.chosen.a.title = "x".repeat(121);
    expect(titleProblem(s, "a", none)).toBe("Keep the title to 120 characters.");
  });

  it("a new preview keeps the choices made by hand", () => {
    const before = initialReview(preview({
      dashboards: [dash("a", "Overview"), dash("b", "Nodes")],
      sources: [ref("prom", { suggestion: "s1" }), ref("logs", { type: "loki", suggestion: "l1" })],
    }), P1);
    before.chosen.a.title = "Mine";
    before.chosen.b.use = false;
    before.mapping.prom = { key: "prom", source_id: "s9" };
    before.mapping.logs = { key: "logs", leave_out: true };
    const next = preview({
      dashboards: [dash("a", "Overview"), dash("b", "Nodes", { suggested_title: "Nodes (2)" }), dash("c", "New")],
      sources: [ref("prom", { suggestion: "s2" }), ref("logs", { type: "loki", suggestion: "l2" })],
    });
    const P2 = { kind: "project", id: "p2" } as const;
    const moved = rebaseReview(before, next, P2, false);
    expect(moved.chosen).toEqual({ a: { use: true, title: "Mine" }, b: { use: false, title: "Nodes (2)" }, c: { use: true, title: "New" } });
    // Another project: a source picked by hand starts again; leaving one out stays.
    expect(moved.mapping).toEqual({ prom: { key: "prom", source_id: "s2" }, logs: { key: "logs", leave_out: true } });
    expect(rebaseReview(before, next, P1, true).mapping.prom).toEqual({ key: "prom", source_id: "s9" });
  });

  it("says a file's size in words", () => {
    expect(sizeWords(512)).toBe("512 bytes");
    expect(sizeWords(2048)).toBe("2.0 KB");
    expect(sizeWords(40 * 1024)).toBe("40 KB");
    expect(sizeWords(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
