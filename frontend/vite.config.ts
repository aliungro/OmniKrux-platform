/// <reference types="vitest/config" />
import { relative } from "node:path";
import { gzipSync } from "node:zlib";
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
        bytes: Buffer.byteLength(chunk.code),
        gzipBytes: gzipSync(chunk.code).byteLength,
        modules: Object.keys(chunk.modules).map(id => "/" + relative(process.cwd(), id).replaceAll("\\", "/")),
      }));
      this.emitFile({ type: "asset", fileName: ".vite/startup-graph.json", source: JSON.stringify({ chunks }) });
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
