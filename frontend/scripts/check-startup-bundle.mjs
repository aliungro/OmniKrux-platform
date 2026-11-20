import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const snapshot = args[0] === "--snapshot" && args.length === 2;
if (args.length && !snapshot) throw new Error("Usage: check-startup-bundle.mjs [--snapshot captured-graph.json]");
// Kept out of dist: everything in dist is served by the app.
const graph = JSON.parse(readFileSync(snapshot ? args[1] : "node_modules/.cache/omnikrux/startup-graph.json", "utf8"));
const chunks = new Map(graph.chunks.map(chunk => [chunk.file, chunk]));
const initial = new Set();
function visit(file) {
  if (initial.has(file)) return;
  if (!chunks.has(file)) throw new Error("Missing startup chunk: " + file);
  initial.add(file);
  for (const dep of chunks.get(file).imports) visit(dep);
}
if (snapshot) {
  for (const chunk of graph.chunks.filter(chunk => chunk.entry)) visit(chunk.file);
} else {
  // Vite's HTML plugin can rewrite chunks after generateBundle. Measure the files served.
  for (const chunk of chunks.values()) {
    const code = readFileSync(join("dist", chunk.file));
    chunk.bytes = code.byteLength;
    chunk.gzipBytes = gzipSync(code).byteLength;
  }
  if (existsSync("dist/.vite")) throw new Error("Build metadata in dist/.vite would be served with the app");
  const html = readFileSync("dist/index.html", "utf8");
  let hasEntry = false;
  for (const [tag, kind] of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attrs = new Map(Array.from(tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g),
      ([, key, quoted, single, bare]) => [key.toLowerCase(), quoted ?? single ?? bare]));
    const entry = kind.toLowerCase() === "script" && attrs.get("type") === "module";
    const preload = kind.toLowerCase() === "link" && attrs.get("rel")?.split(/\s+/).includes("modulepreload");
    if (!entry && !preload) continue;
    const ref = attrs.get(entry ? "src" : "href");
    if (!ref) throw new Error("Missing startup asset URL: " + tag);
    const url = new URL(ref, "https://build.invalid/index.html");
    if (url.origin !== "https://build.invalid") throw new Error("Unmeasured external startup asset: " + ref);
    visit(decodeURIComponent(url.pathname.slice(1)));
    if (entry) hasEntry = true;
  }
  if (!hasEntry) throw new Error("Missing HTML module entry");
}
if (!initial.size) throw new Error("Missing entry chunk");
const deferredModules = [
  "/features/audit/AuditView.tsx", "/features/settings/SettingsView.tsx",
  "/features/settings/AccountsSection.tsx", "/features/settings/ClustersSection.tsx",
  "/features/settings/ConnectAccountDialog.tsx", "/features/settings/ImportKubeconfig.tsx",
  "/features/territories/TerritoryTable.tsx", "/features/inspector/Inspector.tsx",
  "/node_modules/@xterm/", "/node_modules/@codemirror/", "/monitoring/MonitoringApp.tsx",
];
// The Monitoring app loads lazily: only its tab state ships with the shell.
const MONITORING = "/src/monitoring/";
const EAGER_MONITORING = new Set(["/src/monitoring/shell/tabState.ts"]);
let bytes = 0;
let gzipBytes = 0;
for (const chunk of chunks.values()) {
  const eager = initial.has(chunk.file);
  if (eager) {
    bytes += chunk.bytes;
    gzipBytes += chunk.gzipBytes;
  }
  console.log(eager ? "initial" : "deferred", chunk.file, chunk.bytes, chunk.gzipBytes);
}
const errors = [];
for (const path of deferredModules) {
  const owners = [...chunks.values()].filter(chunk => chunk.modules.some(id => id.includes(path)));
  if (!owners.length || owners.some(chunk => initial.has(chunk.file))) errors.push(path);
}
const eagerMonitoring = [...chunks.values()].filter(chunk => initial.has(chunk.file))
  .flatMap(chunk => chunk.modules.filter(id => id.includes(MONITORING) && !EAGER_MONITORING.has(id.slice(id.indexOf(MONITORING)))));
console.log("Initial JavaScript (raw/gzip)", bytes, gzipBytes);
if (eagerMonitoring.length) throw new Error("Monitoring must load lazily; in the initial bundle: " + eagerMonitoring.join(", "));
if (errors.length || bytes > 512180) throw new Error("Startup budget 512180 bytes; missing or eager modules: " + errors.join(", "));
