import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const MONITORING = join(process.cwd(), "src", "monitoring");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/** Static references to the chart chunk: `import`/`export ... from` and bare `import "..."`, minus type-only imports. */
function staticChartImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)[ \t]*(import|export)\s+(type\s+)?([^;'"]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    if (m[2]) continue;
    if (m[1] === "export" && !m[3]) continue;
    if (/(^|\/)charts(\/|$)/.test(m[4])) out.push(m[4]);
  }
  return out;
}

describe("charts are only imported lazily", () => {
  it("no file outside the chart chunk imports it statically", () => {
    const offenders: string[] = [];
    for (const file of files(MONITORING)) {
      const rel = relative(MONITORING, file).split(sep).join("/");
      if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue;
      if (rel.startsWith("charts/") || rel.startsWith("test/")) continue;
      const hits = staticChartImports(readFileSync(file, "utf8"));
      if (hits.length) offenders.push(`${rel}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner sees real static imports and ignores the lazy and type ones", () => {
    expect(staticChartImports(`import ChartView from "../charts";`)).toEqual(["../charts"]);
    expect(staticChartImports(`import { x } from "./charts/units";`)).toEqual(["./charts/units"]);
    expect(staticChartImports(`export { default } from "../../charts";`)).toEqual(["../../charts"]);
    expect(staticChartImports(`import "../charts/Charts.module.css";`)).toEqual(["../charts/Charts.module.css"]);
    expect(staticChartImports(`import type { ChartViewProps } from "../charts";`)).toEqual([]);
    expect(staticChartImports(`const View = lazy(() => import("../../charts"));`)).toEqual([]);
    expect(staticChartImports(`// import x from "../charts"\nconst a = 1;`)).toEqual([]);
  });

  it("the chunk's entry exports the view as its default", () => {
    expect(readFileSync(join(MONITORING, "charts", "index.ts"), "utf8")).toMatch(/export default ChartView/);
  });
});
