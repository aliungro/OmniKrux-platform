import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_VARIABLES,
  DEFAULT_SIZES,
  GRID_COLUMNS,
  MAX_DOCUMENT_BYTES,
  MAX_PANELS,
  MAX_QUERIES,
  MAX_THRESHOLDS,
  MAX_VARIABLES,
  PANEL_TYPES,
  REFRESH_CHOICES,
  SCHEMA_VERSION,
  UNITS,
  dashboardJson,
  defaultOptions,
  emptyDashboard,
  newPanel,
  nextPanelId,
  parseDashboardJson,
  validateDashboard,
  type DashboardSpec,
  type OwnerKind,
  type Problem,
} from "./schema";

interface Case {
  name: string;
  owner: OwnerKind;
  input: unknown;
  normalized: unknown;
  problems: Problem[];
}

const cases: Case[] = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "backend", "tests", "monitoring", "dashboard_schema_cases.json"),
    "utf8",
  ),
);

function problemsOf(v: ReturnType<typeof validateDashboard>): Problem[] {
  if (v.ok) throw new Error("expected problems");
  return v.problems;
}

describe.each(cases)("shared case $name", (c) => {
  it("matches the server", () => {
    const v = validateDashboard(c.input, c.owner);
    if (c.problems.length) expect(v).toEqual({ ok: false, problems: c.problems });
    else expect(v).toEqual({ ok: true, spec: c.normalized });
  });
  it("keeps the server's key order", () => {
    const v = validateDashboard(c.input, c.owner);
    if (!c.problems.length && v.ok) {
      expect(JSON.stringify(v.spec)).toBe(JSON.stringify(c.normalized));
    }
  });
});

describe("constants", () => {
  it("match the server", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(GRID_COLUMNS).toBe(24);
    expect(MAX_PANELS).toBe(100);
    expect(MAX_QUERIES).toBe(10);
    expect(MAX_VARIABLES).toBe(20);
    expect(MAX_THRESHOLDS).toBe(10);
    expect(MAX_DOCUMENT_BYTES).toBe(1_000_000);
    expect(PANEL_TYPES).toEqual(["timeseries", "stat", "gauge", "bar", "table", "logs"]);
    expect(UNITS).toHaveLength(10);
    expect(REFRESH_CHOICES).toEqual([null, "10s", "30s", "1m", "5m", "15m", "1h"]);
    expect(DEFAULT_SIZES.logs).toEqual({ w: 24, h: 10 });
    expect(BUILTIN_VARIABLES).toEqual(["__interval", "__rate_interval", "__range"]);
  });
});

describe("TS-only parity checks", () => {
  const withThreshold = (value: unknown) => ({
    schemaVersion: 1,
    title: "Doc",
    panels: [
      {
        id: "p-1",
        type: "stat",
        title: "T",
        layout: { x: 0, y: 0, w: 6, h: 4 },
        queries: [{ ref: "A", source: { type: "prometheus" }, expr: "up" }],
        options: { thresholds: [{ value, color: "ok" }] },
      },
    ],
  });

  it("a NaN threshold is not a finite number", () => {
    expect(problemsOf(validateDashboard(withThreshold(Number.NaN), "project"))).toEqual([
      { path: "panels[0].options.thresholds[0].value", message: "Expected a finite number." },
    ]);
  });
  it("Infinity is not a finite number either", () => {
    expect(problemsOf(validateDashboard(withThreshold(Infinity), "project"))[0].message).toBe(
      "Expected a finite number.",
    );
  });
  it("text containing NaN is not valid JSON", () => {
    const v = parseDashboardJson('{"schemaVersion": 1, "title": "x", "refresh": NaN}', "project");
    expect(problemsOf(v)[0].path).toBe("");
    expect(problemsOf(v)[0].message).toMatch(/^Not valid JSON: /);
  });
  it("negative zero normalises to zero", () => {
    const v = validateDashboard(withThreshold(-0), "project");
    expect(v.ok && Object.is((v.spec.panels[0].options as { thresholds: { value: number }[] }).thresholds[0].value, 0)).toBe(true);
  });
  it("text length counts code points", () => {
    const title = "\u{1F600}".repeat(120);
    expect(validateDashboard({ schemaVersion: 1, title }, "project").ok).toBe(true);
    expect(validateDashboard({ schemaVersion: 1, title: title + "x" }, "project").ok).toBe(false);
  });
  it("control characters are refused before trimming", () => {
    const v = validateDashboard({ schemaVersion: 1, title: "a\tb" }, "project");
    expect(problemsOf(v)[0].path).toBe("title");
  });
  it("unknown keys sort by code point, not UTF-16 unit", () => {
    const input = JSON.parse('{"schemaVersion":1,"title":"x","\\ud83d\\ude00":1,"\\uffee":2}');
    expect(problemsOf(validateDashboard(input, "project")).map((p) => p.path)).toEqual([
      "￮",
      "\u{1F600}",
    ]);
  });
  it("an unknown key named like an object builtin is reported, not skipped", () => {
    const input = JSON.parse('{"schemaVersion":1,"title":"x","__proto__":1,"constructor":2}');
    expect(problemsOf(validateDashboard(input, "project")).map((p) => p.path)).toEqual([
      "__proto__",
      "constructor",
    ]);
  });
  it("a variable named constructor is not mistaken for a defined one", () => {
    const v = validateDashboard(
      {
        schemaVersion: 1,
        title: "x",
        panels: [
          {
            id: "p-1",
            type: "stat",
            title: "T",
            layout: { x: 0, y: 0, w: 6, h: 4 },
            queries: [{ ref: "A", source: { type: "prometheus" }, expr: "up{a=$constructor}" }],
          },
        ],
      },
      "project",
    );
    expect(problemsOf(v)[0].message).toBe(
      "Uses $constructor, which isn't a variable of this dashboard.",
    );
  });
  it("a document over 1 MB of UTF-8 is refused", () => {
    const v = validateDashboard(
      { schemaVersion: 1, title: "x", description: "é".repeat(600_000) },
      "project",
    );
    expect(problemsOf(v)).toEqual([{ path: "", message: "The dashboard is larger than 1 MB." }]);
  });
  it("text over 1 MB of UTF-8 is refused before parsing", () => {
    const v = parseDashboardJson(`{"a":"${"é".repeat(600_000)}"}`, "project");
    expect(problemsOf(v)).toEqual([{ path: "", message: "The dashboard is larger than 1 MB." }]);
  });
});

describe("parseDashboardJson", () => {
  it("a JSON syntax error is one problem at the top", () => {
    const v = parseDashboardJson('{"schemaVersion": 1,', "project");
    expect(v.ok).toBe(false);
    const problems = (v as { problems: Problem[] }).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe("");
    expect(problems[0].message).toMatch(/^Not valid JSON: /);
  });
  it("valid text is validated", () => {
    const v = parseDashboardJson('{"schemaVersion": 1, "title": "Doc"}', "project");
    expect(v.ok && v.spec.title).toBe("Doc");
  });
});

describe("helpers", () => {
  const layout = { x: 0, y: 0, w: 12, h: 8 };
  it("next panel id fills the first gap", () => {
    const spec = emptyDashboard("D");
    spec.panels = [newPanel("stat", "p-1", layout), newPanel("stat", "p-3", layout)];
    expect(nextPanelId(spec)).toBe("p-2");
    spec.panels = [];
    expect(nextPanelId(spec)).toBe("p-1");
  });
  it("a new logs panel queries Loki", () => {
    expect(newPanel("logs", "p-1", layout).queries[0].source.type).toBe("loki");
    expect(newPanel("stat", "p-1", layout).queries[0].source).toEqual({
      type: "prometheus",
      id: null,
    });
  });
  it("a new panel is a draft: only the empty expression is reported", () => {
    for (const type of PANEL_TYPES) {
      const spec: DashboardSpec = emptyDashboard("D");
      spec.panels = [newPanel(type, "p-1", layout)];
      const v = validateDashboard(JSON.parse(dashboardJson(spec)), "project");
      expect(problemsOf(v)).toEqual([
        { path: "panels[0].queries[0].expr", message: "Use 1 to 10000 characters." },
      ]);
      spec.panels[0].queries[0].expr = "up";
      expect(validateDashboard(spec, "project").ok).toBe(true);
    }
  });
  it("default options validate to themselves", () => {
    for (const type of PANEL_TYPES) {
      const spec = emptyDashboard("D");
      const p = newPanel(type, "p-1", layout);
      p.queries[0].expr = "up";
      spec.panels = [p];
      const v = validateDashboard(spec, "project");
      expect(v.ok && v.spec.panels[0].options).toEqual(defaultOptions(type));
    }
  });
  it("an empty dashboard is valid and round-trips through its JSON", () => {
    const spec = emptyDashboard("D");
    const v = parseDashboardJson(dashboardJson(spec), "group");
    expect(v).toEqual({ ok: true, spec });
    expect(dashboardJson(spec)).toBe(JSON.stringify(spec, null, 2));
  });
});

describe("speed", () => {
  it("validating a one-megabyte document takes under 200 ms", () => {
    const panels = Array.from({ length: 100 }, (_, i) => ({
      id: `p-${i + 1}`,
      type: "timeseries",
      title: "T",
      layout: { x: 0, y: i * 2, w: 12, h: 2 },
      queries: Array.from({ length: 10 }, (_, q) => ({
        ref: String.fromCharCode(65 + q),
        source: { type: "prometheus" },
        expr: "x".repeat(900),
      })),
    }));
    const doc = { schemaVersion: 1, title: "Big", panels };
    const t0 = performance.now();
    const v = validateDashboard(doc, "project");
    const ms = performance.now() - t0;
    expect(v.ok).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});
