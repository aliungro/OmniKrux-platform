// @vitest-environment node
// R11: every provider badge uses dark text (var(--bg)); light ink fails contrast on AKS and OKE.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
const badge = read("./ProviderBadge.module.css");
const providers = read("./provider.module.css");

describe("provider badge contrast", () => {
  it("badge text is var(--bg) for every provider", () => {
    const pv = badge.match(/\.pv\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(pv).toMatch(/(^|[\s;])color:\s*var\(--bg\)/);
  });
  it.each(["aks", "eks", "gke", "oke", "kind", "onprem"])("%s does not override the text colour", (p) => {
    const rule = providers.match(new RegExp(`\\.${p}\\s*\\{([^}]*)\\}`))?.[1];
    expect(rule).toBeDefined();
    expect(rule).not.toMatch(/ink|(^|[\s;])color:/);
  });
});
