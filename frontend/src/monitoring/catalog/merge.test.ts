import { describe, expect, it } from "vitest";
import { catalogOf, metric, projectOf, source, stream } from "./fixtures";
import { catalogAge, ownerCatalog } from "./merge";

describe("ownerCatalog", () => {
  it("merge keeps the first source's metric on a project", () => {
    const catalog = catalogOf("a",
      source("s1", { metrics: [metric("up", { labels: ["job"], help: "first" })] }),
      source("s2", { metrics: [metric("up", { labels: ["other"], help: "second" }), metric("zed")] }),
    );
    const merged = ownerCatalog([{ project: projectOf("a"), catalog, error: null }], "project");
    expect(merged.metrics.map((m) => m.name)).toEqual(["up", "zed"]);
    expect(merged.metrics[0]).toMatchObject({ sourceId: "s1", labels: ["job"], help: "first", projectIds: ["a"] });
    expect(merged.metrics[1].sourceId).toBe("s2");
    expect(merged.hasPrometheus).toBe(true);
    expect(merged.hasLoki).toBe(false);
  });

  it("a group merges members and keeps null sources", () => {
    const a = catalogOf("a", source("s1", { metrics: [metric("up", { labels: ["job", "instance"], series: 3 })] }));
    const b = catalogOf("b", source("s2", { metrics: [metric("up", { labels: ["job", "zone"], series: null })] }));
    const merged = ownerCatalog([
      { project: projectOf("a"), catalog: a, error: null },
      { project: projectOf("b"), catalog: b, error: null },
    ], "group");
    expect(merged.metrics).toHaveLength(1);
    expect(merged.metrics[0]).toMatchObject({ name: "up", labels: ["instance", "job", "zone"], projectIds: ["a", "b"], sourceId: null, series: 3 });
  });

  it("a group takes each project's first source only", () => {
    const a = catalogOf("a", source("s1", { metrics: [metric("up")] }), source("s2", { metrics: [metric("up")] }));
    const merged = ownerCatalog([
      { project: projectOf("a"), catalog: a, error: null },
      { project: projectOf("b"), catalog: null, error: "x" },
    ], "group");
    expect(merged.metrics[0]).toMatchObject({ series: 1, projectIds: ["a"] });
  });

  it("Prometheus notes never show for a logs list", () => {
    const a = catalogOf("a",
      source("s1", { notes: ["Labels per metric come from the first 50000 series."] }),
      source("s2", { source_type: "loki", notes: ["Only the newest streams are listed."] }),
    );
    const one = ownerCatalog([{ project: projectOf("a", "Shop"), catalog: a, error: null }], "project");
    expect(one.notesBy.loki).toEqual(["Only the newest streams are listed."]);
    expect(one.notesBy.prometheus).toEqual(["Labels per metric come from the first 50000 series."]);
    expect(one.notes).toEqual([...one.notesBy.prometheus, ...one.notesBy.loki]);
  });

  it("failed sources become problems in words", () => {
    const a = catalogOf("a",
      source("s1", { source_name: "Prometheus · b", state: "error", message: "Can't reach http://prom:9090." }),
      source("s2", { source_name: "Loki", source_type: "loki", state: "partial", message: "Too many labels.", notes: ["Cut short."] }),
      source("s3", { source_name: "Other", notes: ["Cut short."] }),
    );
    const one = ownerCatalog([{ project: projectOf("a", "Shop"), catalog: a, error: null }], "project");
    expect(one.problems).toEqual(["Prometheus · b: Can't reach http://prom:9090.", "Loki: Too many labels."]);
    expect(one.notes).toEqual(["Cut short."]);
    expect(one.hasLoki).toBe(true);
    const group = ownerCatalog([
      { project: projectOf("a", "Shop"), catalog: a, error: null },
      { project: projectOf("b", "Blog"), catalog: null, error: "That project no longer exists." },
    ], "group");
    expect(group.problems).toEqual([
      "Shop: Prometheus · b: Can't reach http://prom:9090.",
      "Shop: Loki: Too many labels.",
      "Blog: That project no longer exists.",
    ]);
  });

  it("merges streams, sorts values, and takes the oldest build in ms", () => {
    const a = catalogOf("a",
      source("l1", { source_type: "loki", built_at: "2026-11-19T10:00:00Z", streams: [stream("app", ["web", "api"])] }),
      source("l2", { source_type: "loki", built_at: "2026-11-19T09:00:00Z", streams: [stream("app", ["db", "api"]), stream("env", ["prod"])] }),
    );
    const merged = ownerCatalog([{ project: projectOf("a"), catalog: a, error: null }], "project");
    expect(merged.streams).toEqual([
      { name: "app", values: ["api", "db", "web"], sourceId: "l1", projectIds: ["a"] },
      { name: "env", values: ["prod"], sourceId: "l2", projectIds: ["a"] },
    ]);
    expect(merged.builtAt).toBe(Date.parse("2026-11-19T09:00:00Z"));
    expect(ownerCatalog([], "project").builtAt).toBeNull();
  });
});

describe("catalogAge", () => {
  it("catalog age reads like people speak", () => {
    const now = 10_000_000;
    expect(catalogAge(null, now)).toBe("");
    expect(catalogAge(now - 45_000, now)).toBe("just now");
    expect(catalogAge(now - 90_000, now)).toBe("1 min ago");
    expect(catalogAge(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(catalogAge(now - 2 * 3_600_000, now)).toBe("2 h ago");
    expect(catalogAge(now + 5000, now)).toBe("just now");
  });
});
