/// <reference types="vitest/config" />
import { mkdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), {
    name: "startup-graph",
    apply: "build",
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === "chunk").map(chunk => ({
        file: chunk.fileName,
        entry: chunk.isEntry,
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        modules: Object.keys(chunk.modules).map(id => "/" + relative(process.cwd(), id).replaceAll("\\", "/")),
      }));
      // Outside dist on purpose: the app serves every file in dist.
      mkdirSync("node_modules/.cache/omnikrux", { recursive: true });
      writeFileSync("node_modules/.cache/omnikrux/startup-graph.json", JSON.stringify({ chunks }));
    },
  }],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
