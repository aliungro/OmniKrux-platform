import { readFileSync } from "node:fs";

const graph = JSON.parse(readFileSync(process.argv[2] ?? "dist/.vite/startup-graph.json", "utf8"));
const chunks = new Map(graph.chunks.map(chunk => [chunk.file, chunk]));
const initial = new Set();
function visit(file) {
  if (initial.has(file)) return;
  initial.add(file);
  for (const dep of chunks.get(file).imports) visit(dep);
}
for (const chunk of graph.chunks.filter(chunk => chunk.entry)) visit(chunk.file);
if (!initial.size) throw new Error("Missing entry chunk");
const deferredModules = [
  "/features/audit/AuditView.tsx", "/features/settings/SettingsView.tsx",
  "/features/settings/AccountsSection.tsx", "/features/settings/ClustersSection.tsx",
  "/features/settings/ConnectAccountDialog.tsx", "/features/settings/ImportKubeconfig.tsx",
  "/features/territories/TerritoryTable.tsx", "/features/inspector/Inspector.tsx",
  "/node_modules/@xterm/", "/node_modules/@codemirror/",
];
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
console.log("Initial JavaScript (raw/gzip)", bytes, gzipBytes);
if (errors.length || bytes > 512180) throw new Error("Startup budget 512180 bytes; missing or eager modules: " + errors.join(", "));
