import { describe, expect, it } from "vitest";
import { browseMetrics } from "../catalog/metrics";
import { appendPanel } from "../dashboards/layout";
import { emptyDashboard, validateDashboard } from "../dashboards/schema";
import type { OwnerKind } from "../dashboards/schema";
import { candidatePanel } from "./candidates";
import { buildFinderIndex, findPanels } from "./finder";
import { MAX_SUGGESTIONS, pickRequestCounter, suggestPanels, suggestionsHeading } from "./suggest";
import { CAT, KIND, catalog, counter, gauge, streamOf } from "./testCatalogs";

describe("suggestPanels", () => {
  it("suggestions appear only when their metrics exist", () => {
    expect(suggestPanels(CAT).map((c) => c.key)).toEqual([
      "requestRate", "errorRate", "latencyP95", "podRestarts", "logVolume", "memoryByPod", "errorLogs",
    ]);
    expect(suggestPanels(catalog([gauge("up", ["job"])], [])).map((c) => c.key)).toEqual(["targetsDown"]);
    expect(suggestPanels(catalog([]))).toEqual([]);
  });

  it("suggestion queries are exact", () => {
    const s = Object.fromEntries(suggestPanels(CAT).map((c) => [c.key, c.expr]));
    expect(s.requestRate).toBe("sum by (route) (rate(http_requests_total[$__rate_interval]))");
    expect(s.errorRate).toBe(
      'sum(rate(http_requests_total{status=~"5.."}[$__rate_interval])) / sum(rate(http_requests_total[$__rate_interval]))',
    );
    expect(s.latencyP95).toBe(
      "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[$__rate_interval])))",
    );
    expect(s.podRestarts).toBe("topk(5, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])))");
    expect(s.logVolume).toBe('sum by (level) (count_over_time({app=~".+"}[$__interval]))');
    expect(s.memoryByPod).toBe('topk(10, sum by (namespace, pod) (container_memory_working_set_bytes{container!=""}))');
    expect(s.errorLogs).toBe('{app=~".+"} |~ "(?i)(error|fatal|panic)"');
  });

  it("the kind cluster's catalog gives the walkthrough's suggestions", () => {
    const s = suggestPanels(KIND);
    expect(s.find((c) => c.key === "requestRate")!.expr)
      .toBe("sum by (handler) (rate(prometheus_http_requests_total[$__rate_interval]))");
    expect(s.find((c) => c.key === "errorRate")!.expr).toContain('code=~"5.."');
    expect(s.find((c) => c.key === "cpuByPod")!.expr).toBe(
      'topk(10, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!=""}[$__rate_interval])))',
    );
    expect(s.find((c) => c.key === "targetsDown")!.expr).toBe("count(up == 0) or vector(0)");
    expect(s.find((c) => c.key === "logVolume")!.expr).toBe('sum by (level) (count_over_time({job=~".+"}[$__interval]))');
    expect(s.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });

  it("node CPU is written with the idle matcher", () => {
    const c = catalog([counter("node_cpu_seconds_total", ["mode", "instance"])]);
    expect(suggestPanels(c)[0].expr).toBe(
      '1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))',
    );
  });

  it("the Loki label follows the stream label order", () => {
    const c = catalog([], [streamOf("job", ["x"]), streamOf("namespace", ["y"]), streamOf("zed", ["z"])]);
    expect(suggestPanels(c)[0].expr).toBe('sum by (namespace) (count_over_time({namespace=~".+"}[$__interval]))');
    const only = catalog([], [streamOf("zed", ["z"])]);
    expect(suggestPanels(only)[0]).toMatchObject({ title: "Log volume by zed", subtitle: "Loki · by zed" });
  });

  it("the request counter prefers http_requests_total, then most series", () => {
    const pick = (...ms: ReturnType<typeof counter>[]) => pickRequestCounter(browseMetrics(catalog(ms)))?.name ?? null;
    expect(pick(counter("a_requests_total", [], 99), counter("http_requests_total", [], 1))).toBe("http_requests_total");
    expect(pick(counter("x_requests_total", [], 99), counter("web_http_requests_total", [], 1))).toBe("web_http_requests_total");
    expect(pick(counter("a_requests_total", [], 5), counter("b_request_total", [], 7))).toBe("b_request_total");
    expect(pick(counter("a_requests_total", [], 5), counter("b_requests_total", [], 5))).toBe("a_requests_total");
    expect(pick(counter("jobs_total", []))).toBeNull();
  });

  it("the heading names what the sources are", () => {
    expect(suggestionsHeading("prod-east", CAT)).toBe("Suggested for prod-east · from what Prometheus and Loki have");
    expect(suggestionsHeading("p", catalog([gauge("up", [])]))).toBe("Suggested for p · from what Prometheus have");
    expect(suggestionsHeading("p", catalog([], [streamOf("a", ["b"])]))).toBe("Suggested for p · from what Loki have");
  });
});

describe("candidatePanel", () => {
  it("uses the owner's source rule", () => {
    const c = suggestPanels(CAT)[0];
    expect(candidatePanel(c, "p-1", "group").queries[0].source).toEqual({ type: "prometheus", id: null });
    expect(candidatePanel(c, "p-1", "project").queries[0].source).toEqual({ type: "prometheus", id: "prom" });
    const logs = suggestPanels(CAT).find((x) => x.key === "errorLogs")!;
    expect(candidatePanel(logs, "p-1", "project").queries[0].source).toEqual({ type: "loki", id: "loki" });
  });

  it("applies the unit and options by type", () => {
    const by = Object.fromEntries(suggestPanels(CAT).map((c) => [c.key, candidatePanel(c, "p-1", "project")]));
    expect(by.errorRate.options).toMatchObject({ unit: "percentunit", max: 1 });
    expect(by.errorLogs.options).toEqual({ limit: 100, wrap: true, order: "newest" });
    expect(by.requestRate.layout).toBeUndefined();
    const down = candidatePanel(suggestPanels(KIND).find((c) => c.key === "targetsDown")!, "p-1", "project");
    expect(down.options).toMatchObject({ thresholds: [{ value: 1, color: "bad" }] });
  });

  it("every suggestion and candidate is a valid panel", () => {
    const kinds: OwnerKind[] = ["project", "group"];
    const texts = ["errors by route", "api logs", "p99 latency", "crashes", "cpu", "logs", "volume", "requests", "up"];
    for (const cat of [CAT, KIND]) {
      const index = buildFinderIndex(cat);
      const all = [...suggestPanels(cat), ...texts.flatMap((t) => findPanels(index, t, 20))];
      expect(all.length).toBeGreaterThan(7);
      for (const c of all) {
        for (const kind of kinds) {
          const r = validateDashboard(appendPanel(emptyDashboard("t"), candidatePanel(c, "p-1", kind)), kind);
          expect(r.ok, `${c.key} (${kind})`).toBe(true);
        }
      }
    }
  });
});
