// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const shellCss = readFileSync(join(__dirname, "Shell.module.css"), "utf8");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

describe("the table zone outline", () => {
  it("the table outline is drawn inside the whole pane", () => {
    const block = shellCss.match(/\.pane\[data-keyboard-zone="table"\]::after\s*\{[^}]*\}/)?.[0] ?? "";
    expect(block).toContain("inset: 0");
    expect(block).toContain("border: 2px solid var(--focus)");
    expect(block).toContain("pointer-events: none");
    expect(block).toContain("z-index: 4");
    const pane = shellCss.match(/\.pane\s*\{[^}]*\}/)?.[0] ?? "";
    expect(pane).toContain("position: relative");
    expect(pane).toContain("isolation: isolate");
  });

  it("no scroller draws the table outline", () => {
    const src = join(__dirname, "..", "..");
    const offenders = cssFiles(src).filter((f) => !f.endsWith("Shell.module.css") && readFileSync(f, "utf8").includes('data-keyboard-zone="table"'));
    expect(offenders).toEqual([]);
  });
});
