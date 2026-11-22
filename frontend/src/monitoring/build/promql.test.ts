import { describe, expect, it } from "vitest";
import {
  UNREADABLE, findRawCounters, firstMetric, isLogQlMetric, isRateQuery, logSelector, quickCheck,
  rangeDurations, replaceDurations, scanSelectors, wrapRate,
} from "./promql";

const counter = (n: string) => n.endsWith("_total");

describe("promql", () => {
  it.each([
    ["http_requests_total", "rate(http_requests_total[$__rate_interval])"],
    ['sum by (route) (http_requests_total{status="500"})', 'sum by (route) (rate(http_requests_total{status="500"}[$__rate_interval]))'],
    ["a_total / b_total", "rate(a_total[$__rate_interval]) / rate(b_total[$__rate_interval])"],
    ["x_total # http_requests_total", "rate(x_total[$__rate_interval]) # http_requests_total"],
    ['label_replace(up, "d", "http_requests_total", "", "")', 'label_replace(up, "d", "http_requests_total", "", "")'],
  ])("wrapRate %s", (q, out) => expect(wrapRate(q, findRawCounters(q, counter))).toBe(out));

  it("offers nothing that already has a range or a modifier", () => {
    expect(findRawCounters("rate(http_requests_total[5m])", counter)).toEqual([]);
    expect(findRawCounters("http_requests_total offset 1h", counter)).toEqual([]);
    expect(findRawCounters("max_over_time(x_total[1h:5m])", counter)).toEqual([]);
  });

  it("finds literal windows, not subqueries or variables", () => {
    expect(rangeDurations("rate(x[1m]) + rate(y[$__rate_interval]) + max_over_time(z[1h:5m])").map((d) => d.seconds)).toEqual([60]);
  });

  it("replaces durations in place", () => {
    const q = 'rate(x[1m]) + rate(y{a="b"}[ 5m ])';
    expect(replaceDurations(q, rangeDurations(q), "10m")).toBe('rate(x[10m]) + rate(y{a="b"}[ 10m ])');
  });

  it("unbalanced queries are unreadable", () => {
    expect(quickCheck('up{job="x}')).toBe(UNREADABLE);
    expect(quickCheck("rate(up[5m)")).toBe(UNREADABLE);
    expect(quickCheck('sum(rate(up{a="}"}[5m]))')).toBeNull();
    expect(scanSelectors("up)")).toBeNull();
  });

  it("skips label lists, keywords and functions", () => {
    const q = "sum by (job, instance) (x_total) / on (job) group_left (team) y_total and ignoring(a) z_total";
    expect(scanSelectors(q)!.map((r) => r.metric)).toEqual(["x_total", "y_total", "z_total"]);
    expect(scanSelectors('{job="a"} + up')!.map((r) => r.metric)).toEqual([null, "up"]);
  });

  it("rate queries", () => {
    expect(isRateQuery("sum by (route) (rate(x[5m]))")).toBe(true);
    expect(isRateQuery("increase(x[5m])")).toBe(true);
    expect(isRateQuery("histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))")).toBe(false);
    expect(isRateQuery("rate(x[5m]) * 100")).toBe(false);
  });

  it("first metric", () => {
    expect(firstMetric('sum by (a) (rate(x_total{b="c"}[5m]))')).toBe("x_total");
    expect(firstMetric("1 + 2")).toBeNull();
  });

  it("logql helpers", () => {
    expect(isLogQlMetric('sum(count_over_time({a="b"}[1m]))')).toBe(true);
    expect(isLogQlMetric('sum by (level) (count_over_time({a="b"}[1m]))')).toBe(true);
    expect(isLogQlMetric('{a="b"}')).toBe(false);
    expect(logSelector('{app="api"} |= "x{y}"')).toBe('{app="api"}');
    expect(logSelector("no braces")).toBeNull();
  });
});
