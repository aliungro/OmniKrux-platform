// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const srcDir = fileURLToPath(new URL("../", import.meta.url));

describe("scrollbars", () => {
  it("the global scrollbar is thin plum with a lighter hover", () => {
    expect(tokens).toMatch(/--scroll-thumb:\s*#3A3452/i);
    expect(tokens).toMatch(/--scroll-thumb-hover:\s*#5A5080/i);
    expect(tokens).toMatch(/::-webkit-scrollbar-thumb:hover/);
    expect(tokens).toMatch(/@supports not selector\(::-webkit-scrollbar\)/);
    expect(tokens).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/);
  });

  it("no component styles its own scrollbar", () => {
    const files = readdirSync(srcDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".css"))
      .map((f) => join(srcDir, f))
      .filter((f) => f !== join(srcDir, "design", "tokens.css"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const css = readFileSync(file, "utf8");
      const name = file.slice(srcDir.length);
      expect(css, name).not.toMatch(/scrollbar-color/);
      expect(css, name).not.toMatch(/::-webkit-scrollbar/);
      for (const [, value] of css.matchAll(/scrollbar-width:\s*([^;}\n]+)/g)) {
        expect(value.trim(), name).toBe("none");
      }
    }
  });
});
