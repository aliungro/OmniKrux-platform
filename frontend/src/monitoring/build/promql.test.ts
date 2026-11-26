import { describe, expect, it } from "vitest";
import {
  ONE_QUERY, UNREADABLE, findRawCounters, firstMetric, isLogQlMetric, isRateQuery, logSelector, quickCheck,
  rangeDurations, replaceDurations, scanSelectors, severalQueries, wrapRate,
} from "./promql";

const counter = (n: string) => n.endsWith("_total");

describe("promql", () => {
  it.each([
    ["http_requests_total", "rate(http_requests_total[$__rate_interval])"],
    ['sum by (route) (http_requests_total{status="500"})', 'sum by (route) (rate(http_requests_total{status="500"}[$__rate_interval]))'],
    ["a_total / b_total", "rate(a_total[$__rate_interval]) / rate(b_total[$__rate_interval])"],
    ["x_total # http_requests_total", "rate(x_total[$__rate_interval]) # http_requests_total"],
    ["${env}_requests_total", "${env}_requests_total"],
    ["${a}_total + x_total${b}", "${a}_total + x_total${b}"],
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

  it("variables glued to a name are never selectors", () => {
    expect(findRawCounters("${env}_requests_total", counter)).toEqual([]);
    expect(scanSelectors("${a}_total{x=\"y\"}")!.map((r) => r.metric)).toEqual([null]);
  });

  it("comments are handled the same everywhere", () => {
    expect(isRateQuery("sum by (a) (rate(x[5m])) # c")).toBe(true);
    expect(isRateQuery("sum(rate(x[5m])) by (a)")).toBe(true);
    expect(isLogQlMetric("# c\nsum(x)")).toBe(true);
    expect(logSelector('# {no}\n{a="b"}')).toBe('{a="b"}');
  });

  it("by and without are case-insensitive", () => {
    expect(firstMetric("sum BY (a) (x)")).toBe("x");
    expect(isRateQuery("SUM(rate(x[5m]))")).toBe(false);
    expect(isRateQuery("sum WITHOUT (a) (rate(x[5m]))")).toBe(true);
  });

  it.each([
    ["up\nrate(x[5m])", true],
    ["sum(\n rate(x[5m]))", false],
    ['{a="b"}\n{c="d"}', true],
    ['{a="b"}\n|= "x"', false],
    // F9: a line that starts with an operator or a joining word continues the query before it.
    ["up\nor vector(0)", false],
    ["up\n/ 2", false],
    ["a\nunless b", false],
    ["sum(x)\nand on (job) y", false],
    // A line that ends with an operator or a joining word carries on too.
    ["up /\n2", false],
    ["up and\nvector(1)", false],
    ['{a="b"} |=\n{c="d"}', false],
    // Blank lines and comments are not lines of the query.
    ["up\n\n# rate(x[5m])\n", false],
    ["up # one\n\n# two\nrate(x[5m])", true],
    ['{a="b"}\n{c="d"}\n{e="f"}', true],
    ['{a="b"} | json\n{c="d"}', true],
    ["up", false],
    ["", false],
    ['up{job="a\nb"}', false],
    // A vector-matching list at the end of a line is part of the operator, never an end.
    ["a\n* on (job)\nb", false],
    ["x / ignoring(code) group_left(node)\ny", false],
    ["a * on (namespace, pod) group_left(node)\nkube_pod_info", false],
    ["a\n+ ignoring (instance)\nb", false],
    ["a / on (job) group_right (team)\nb", false],
    ["a == bool on (job)\nb", false],
    ["sum by (job) (rate(x[5m]))\n/ on (job) group_left\nsum by (job) (up)", false],
    // A postfix `by (…)` does end an aggregation: a query after it is another one.
    ["sum(x) by (job)\nup", true],
    ["up\nsum(x)\nrate(y[5m])", true],
    // LogQL stages chained across lines are one query; a new selector is another.
    ['{a="b"}\n| json\n| level="error"', false],
    ['{a="b"} |= "x"\n  != "y"', false],
    ['{a="b"} | logfmt | status >= 500\nmethod="GET"', false],
    ['{a="b"} | logfmt\n{c="d"}', true],
  ])("severalQueries %j is %s", (q, out) => expect(severalQueries(q)).toBe(out));

  it("one query at a time is said plainly", () => {
    expect(ONE_QUERY).toBe("Explore runs one query at a time. Keep one query in the field, or run them one after another.");
  });
});
