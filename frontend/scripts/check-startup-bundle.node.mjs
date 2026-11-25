import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("checks emitted bytes and HTML modulepreloads against reachable chunks", t => {
  const dir = mkdtempSync(join(tmpdir(), "omnikrux-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  const meta = join(dir, "node_modules/.cache/omnikrux");
  mkdirSync(dist, { recursive: true });
  mkdirSync(meta, { recursive: true });
  const chunk = (file, entry = false) => ({ file, entry, imports: [], bytes: 1, gzipBytes: 1, modules: [] });
  const feature = chunk("features.js");
  feature.modules = [
    "audit/AuditView", "settings/SettingsView", "settings/AccountsSection", "settings/ClustersSection",
    "settings/ConnectAccountDialog", "settings/ImportKubeconfig", "territories/TerritoryTable", "inspector/Inspector",
  ].map(name => "/features/" + name + ".tsx").concat("/node_modules/@xterm/xterm/x", "/node_modules/@codemirror/view/x", "/monitoring/MonitoringApp.tsx");
  const entry = chunk("entry.js", true);
  const chunks = [entry, chunk("preload.js"), feature];
  const saveGraph = () => writeFileSync(join(meta, "startup-graph.json"), JSON.stringify({ chunks }));
  saveGraph();
  for (const { file } of chunks) writeFileSync(join(dist, file), " ");
  const html = href => writeFileSync(join(dist, "index.html"),
    '<script type="module" src="/entry.js"></script><link rel="modulepreload" href="' + href + '">');
  html("/preload.js");
  const checker = fileURLToPath(new URL("./check-startup-bundle.mjs", import.meta.url));
  const run = () => execFileSync(process.execPath, [checker], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  assert.match(run(), /Initial JavaScript \(raw\/gzip\) 2 42/);
  writeFileSync(join(dist, "preload.js"), Buffer.alloc(512180));
  assert.throws(run, /512180/);
  writeFileSync(join(dist, "preload.js"), " ");
  html("/unknown.js");
  assert.throws(run, /unknown.js/);
  html("/preload.js");
  entry.imports = ["missing.js"];
  saveGraph();
  assert.throws(run, /missing.js/);
  entry.imports = [];
  saveGraph();
  // Build-only metadata must never be served with the app.
  mkdirSync(join(dist, ".vite"));
  writeFileSync(join(dist, ".vite/startup-graph.json"), "{}");
  assert.throws(run, /served/);
  rmSync(join(dist, ".vite"), { recursive: true });
  run();
  rmSync(join(dist, "entry.js"));
  assert.throws(run, /ENOENT.*entry.js/);
});

// A snapshot graph: the deferred modules live in a lazy chunk; `eager` lands in the entry chunk.
function snapshotRun(t, eager) {
  const dir = mkdtempSync(join(tmpdir(), "omnikrux-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deferred = [
    "audit/AuditView", "settings/SettingsView", "settings/AccountsSection", "settings/ClustersSection",
    "settings/ConnectAccountDialog", "settings/ImportKubeconfig", "territories/TerritoryTable", "inspector/Inspector",
  ].map(name => "/src/features/" + name + ".tsx").concat(
    "/node_modules/@xterm/xterm/x", "/node_modules/@codemirror/view/x", "/src/monitoring/MonitoringApp.tsx");
  const chunks = [
    { file: "entry.js", entry: true, imports: [], bytes: 1, gzipBytes: 1, modules: ["/src/main.tsx", ...eager] },
    { file: "lazy.js", entry: false, imports: [], bytes: 1, gzipBytes: 1, modules: deferred },
  ];
  const graph = join(dir, "graph.json");
  writeFileSync(graph, JSON.stringify({ chunks }));
  const checker = fileURLToPath(new URL("./check-startup-bundle.mjs", import.meta.url));
  return () => execFileSync(process.execPath, [checker, "--snapshot", graph], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

test("a monitoring module in the initial graph fails the check", t => {
  const run = snapshotRun(t, ["/src/monitoring/sidebar/Sidebar.tsx", "/src/monitoring/shell/tabState.ts"]);
  assert.throws(run, error => {
    assert.match(String(error.stderr ?? error.message), /\/src\/monitoring\/sidebar\/Sidebar\.tsx/);
    assert.doesNotMatch(String(error.stderr ?? error.message), /tabState/);
    return true;
  });
});

test("tabState may be eager", t => {
  const run = snapshotRun(t, ["/src/monitoring/shell/tabState.ts"]);
  assert.match(run(), /Initial JavaScript \(raw\/gzip\) 1 1/);
});
