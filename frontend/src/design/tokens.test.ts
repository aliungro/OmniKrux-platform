// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
describe("tokens", () => {
  it.each([["--aks", "#2F8BFF"], ["--eks", "#FF9A1F"], ["--gke", "#2FBF71"], ["--oke", "#E2543E"],
           ["--kind", "#7DD3FC"], ["--onprem", "#A3A0B8"], ["--bad", "#FF4FA0"], ["--bg", "#15131F"]])(
    "%s is %s", (name, hex) => expect(css).toMatch(new RegExp(`${name}:\s*${hex}`, "i")));
});
