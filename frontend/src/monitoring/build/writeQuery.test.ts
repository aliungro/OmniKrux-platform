import { describe, expect, it } from "vitest";
import type { OwnerStreamLabel } from "../catalog/merge";
import type { BrowseMetric, MetricKind } from "../catalog/metrics";
import {
  guessUnit, humanTitle, selectorText, writeLogQuery, writeMetricQuery, writeVolumeQuery,
} from "./writeQuery";

const m = (name: string, kind: MetricKind): BrowseMetric => ({
  name, kind, typeLabel: kind, help: null, labels: [], series: 1, sourceId: null,
});
const stream = (name: string): OwnerStreamLabel => ({ name, values: [], sourceId: null, projectIds: [] });

describe("writeQuery", () => {
  it("writes the X2 queries", () => {
    expect(writeMetricQuery(m("http_requests_total", "counter"), "route", { status: "500" }))
      .toBe('sum by (route) (rate(http_requests_total{status="500"}[$__rate_interval]))');
    expect(writeMetricQuery(m("http_request_duration_seconds", "histogram"), "route", {}))
      .toBe("histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[$__rate_interval])))");
    expect(writeMetricQuery(m("container_memory_working_set_bytes", "gauge"), null, { namespace: "api" }))
      .toBe('container_memory_working_set_bytes{namespace="api"}');
    expect(writeVolumeQuery('{namespace="api"}', "level")).toBe('sum by (level) (count_over_time({namespace="api"}[$__interval]))');
    expect(writeLogQuery({}, [stream("job"), stream("namespace")])).toBe('{namespace=~".+"}');
  });

  it("covers every kind with and without a split", () => {
    expect(writeMetricQuery(m("a_total", "counter"), null, {})).toBe("sum(rate(a_total[$__rate_interval]))");
    expect(writeMetricQuery(m("d", "histogram"), null, {}, 0.5)).toBe("histogram_quantile(0.5, sum by (le) (rate(d_bucket[$__rate_interval])))");
    expect(writeMetricQuery(m("s", "summary"), "r", { a: "b" }))
      .toBe('sum by (r) (rate(s_sum{a="b"}[$__rate_interval])) / sum by (r) (rate(s_count{a="b"}[$__rate_interval]))');
    expect(writeMetricQuery(m("s", "summary"), null, {})).toBe("sum(rate(s_sum[$__rate_interval])) / sum(rate(s_count[$__rate_interval]))");
    expect(writeMetricQuery(m("g", "gauge"), "r", {})).toBe("sum by (r) (g)");
    expect(writeMetricQuery(m("u", "unknown"), null, {})).toBe("u");
    expect(writeVolumeQuery('{a="b"}', null)).toBe('sum(count_over_time({a="b"}[$__interval]))');
    expect(writeLogQuery({ b: "2", a: "1" }, [])).toBe('{a="1",b="2"}');
    expect(writeLogQuery({}, [stream("zed")])).toBe('{zed=~".+"}');
  });

  it("writes extra matchers sorted with the equality ones", () => {
    expect(selectorText("up", { mode: "idle" }, [{ label: "container", op: "!=", value: "" }]))
      .toBe('up{container!="",mode="idle"}');
    expect(writeMetricQuery(m("http_requests_total", "counter"), null, {}, 0.95, [{ label: "code", op: "=~", value: "5.." }]))
      .toBe('sum(rate(http_requests_total{code=~"5.."}[$__rate_interval]))');
  });

  it("values with quotes and backslashes are escaped", () => {
    expect(selectorText("up", { a: 'x"y\\z\nw' })).toBe('up{a="x\\"y\\\\z\\nw"}');
    expect(selectorText("up", {}, [{ label: "a", op: "=~", value: 'a"}|{b' }])).toBe('up{a=~"a\\"}|{b"}');
    expect(writeLogQuery({ app: '"} or {x="' }, [])).toBe('{app="\\"} or {x=\\""}');
  });

  it("odd names are not written", () => {
    // The writers refuse by throwing, so nothing is returned that could carry odd text.
    const odd = ["a b", 'a"b', "a{b", "a}b", "a\nb", "1abc", "", "a-b"];
    for (const name of odd) {
      expect(() => selectorText(name, {})).toThrow();
      expect(() => writeMetricQuery(m(name, "counter"), null, {})).toThrow();
      expect(() => writeMetricQuery(m(name, "histogram"), null, {})).toThrow();
      expect(() => selectorText("up", { [name]: "x" })).toThrow();
      expect(() => selectorText("up", {}, [{ label: name, op: "=", value: "x" }])).toThrow();
      expect(() => writeMetricQuery(m("up", "gauge"), name, {})).toThrow();
      expect(() => writeLogQuery({ [name]: "x" }, [])).toThrow();
      expect(() => writeLogQuery({}, [stream(name)])).toThrow();
      expect(() => writeVolumeQuery('{a="b"}', name)).toThrow();
    }
    expect(() => writeLogQuery({}, [])).toThrow();
    expect(() => writeMetricQuery(m("h", "histogram"), null, {}, Number.NaN)).toThrow();
  });

  it("units and titles", () => {
    expect(guessUnit(m("http_requests_total", "counter"))).toBe("reqps");
    expect(guessUnit(m("net_bytes_total", "counter"))).toBe("Bps");
    expect(guessUnit(m("process_cpu_seconds_total", "counter"))).toBe("cores");
    expect(guessUnit(m("x_total", "counter"))).toBe("short");
    expect(guessUnit(m("http_request_duration_seconds", "histogram"))).toBe("s");
    expect(guessUnit(m("mem_bytes", "gauge"))).toBe("bytes");
    expect(guessUnit(m("mem", "unknown"))).toBe("short");
    expect(humanTitle("http_requests_total")).toBe("Http requests");
    expect(humanTitle("container_cpu_usage_seconds_total")).toBe("CPU");
    expect(humanTitle("up")).toBe("Targets up");
  });

  it("a volume query is not swallowed by a trailing comment", () => {
    expect(writeVolumeQuery('{a="b"} # c', null)).toBe('sum(count_over_time({a="b"} # c\n[$__interval]))');
    expect(() => writeVolumeQuery('{a="b', null)).toThrow();
  });

  it("reserved words are written as __name__", () => {
    for (const n of ["nan", "inf", "NaN", "sum", "Count", "offset", "by", "bool", "and"]) {
      expect(writeMetricQuery(m(n, "gauge"), null, {})).toBe(`{__name__="${n}"}`);
    }
    expect(writeMetricQuery(m("sum", "gauge"), null, { a: "x" })).toBe('{__name__="sum",a="x"}');
    expect(writeMetricQuery(m("count", "counter"), null, {})).toBe('sum(rate({__name__="count"}[$__rate_interval]))');
    expect(writeMetricQuery(m("sum", "histogram"), null, {})).toContain("sum_bucket");
  });

  it("log queries skip unwritable stream labels and empty values", () => {
    expect(writeLogQuery({}, [stream("a b"), stream("zed")])).toBe('{zed=~".+"}');
    expect(writeLogQuery({ a: "", b: "x" }, [])).toBe('{b="x"}');
    expect(() => writeLogQuery({ a: "" }, [stream("job")])).toThrow();
    expect(() => writeLogQuery({}, [stream("a b"), stream("1x")])).toThrow();
  });
});
