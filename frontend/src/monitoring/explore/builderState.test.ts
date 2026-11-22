import { describe, expect, it } from "vitest";
import type { BrowseMetric } from "../catalog/metrics";
import { builderQuery, builderReducer, EMPTY_BUILDER, metricMatch, writableLabel } from "./builderState";

const metric = (name: string, labels: string[], kind: BrowseMetric["kind"] = "counter"): BrowseMetric =>
  ({ name, kind, typeLabel: kind, help: null, labels, series: 1, sourceId: "s1" });
const requests = metric("http_requests_total", ["pod", "route", "status"]);

describe("the builder state", () => {
  it("picking a metric splits by its first useful label", () => {
    const state = builderReducer({ ...EMPTY_BUILDER, only: { a: "1" }, detached: true }, { type: "pickMetric", metric: requests });
    expect(state).toEqual({ metric: "http_requests_total", stream: false, split: "route", only: {}, detached: false });
    const none = builderReducer(EMPTY_BUILDER, { type: "pickMetric", metric: metric("up", ["job"], "gauge") });
    expect(none.split).toBeNull();
    // The first of the useful labels in their own order, not the metric's.
    expect(builderReducer(EMPTY_BUILDER, { type: "pickMetric", metric: metric("x_total", ["method", "handler"]) }).split).toBe("handler");
  });

  it("split and only toggle and never overlap", () => {
    let s = builderReducer(EMPTY_BUILDER, { type: "pickMetric", metric: requests });
    s = builderReducer(s, { type: "only", label: "status", value: "500" });
    expect(s.only).toEqual({ status: "500" });
    s = builderReducer(s, { type: "only", label: "status", value: "500" });
    expect(s.only).toEqual({});
    s = builderReducer(s, { type: "only", label: "pod", value: "a" });
    s = builderReducer(s, { type: "split", label: "pod" });
    expect(s).toMatchObject({ split: "pod", only: {} });
    s = builderReducer(s, { type: "split", label: "pod" });
    expect(s.split).toBeNull();
    s = builderReducer(s, { type: "only", label: "pod", value: "a" });
    s = builderReducer(s, { type: "only", label: "pod", value: "b" });
    expect(s.only).toEqual({ pod: "b" });
    expect(builderReducer(s, { type: "only", label: "pod", value: null }).only).toEqual({});
  });

  it("typing detaches and a chip reattaches", () => {
    let s = builderReducer(EMPTY_BUILDER, { type: "pickMetric", metric: requests });
    s = builderReducer(s, { type: "typed" });
    expect(s.detached).toBe(true);
    expect(builderReducer(s, { type: "split", label: "pod" }).detached).toBe(false);
    expect(builderReducer(s, { type: "only", label: "pod", value: "a" }).detached).toBe(false);
    expect(builderReducer(s, { type: "reset" })).toEqual(EMPTY_BUILDER);
  });

  it("writes metric and log queries through the writers and refuses what they refuse", () => {
    const s = builderReducer(EMPTY_BUILDER, { type: "pickMetric", metric: requests });
    expect(builderQuery(s, [requests], [])).toBe("sum by (route) (rate(http_requests_total[$__rate_interval]))");
    expect(builderQuery({ ...s, only: { status: 'a"b' } }, [requests], [])).toBe('sum by (route) (rate(http_requests_total{status="a\\"b"}[$__rate_interval]))');
    expect(builderQuery({ ...s, only: { "bad-label": "x" } }, [requests], [])).toBeNull();
    expect(builderQuery(s, [], [])).toBeNull();
    const logs = builderReducer(EMPTY_BUILDER, { type: "pickStream", label: "app", value: "api" });
    expect(builderQuery(logs, [], [])).toBe('{app="api"}');
    expect(metricMatch(metric("lat_seconds", [], "histogram"))).toBe("lat_seconds_bucket");
    expect(metricMatch(metric("up", [], "gauge"))).toBe("up");
    expect(writableLabel("app")).toBe(true);
    expect(writableLabel("a-b")).toBe(false);
  });
});
