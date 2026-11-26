import { describe, expect, it } from "vitest";
import { shortQuery } from "./shortQuery";

describe("shortQuery", () => {
  it("leaves a short query alone and collapses its spaces", () => {
    expect(shortQuery("up")).toBe("up");
    expect(shortQuery("sum  by (job)\n  (up)")).toBe("sum by (job) (up)");
  });

  it("shortQuery cuts at a token boundary", () => {
    const expr = "sum by (handler) (rate(prometheus_http_requests_total[5m])) / sum(rate(prometheus_http_requests_total[5m]))";
    expect(shortQuery(expr)).toBe("sum by (handler) (rate(prometheus_http_requests_total[5m]))…");
    expect(shortQuery(expr, 30)).toBe("sum by (handler) (rate(…");
    expect(shortQuery(expr, 12)).toBe("sum by (…");
    for (const max of [12, 30, 60]) expect(shortQuery(expr, max).length).toBeLessThanOrEqual(max);
  });

  it("shortQuery never cuts inside quotes", () => {
    const expr = '{app="checkout api server",level=~"error|fatal"} |= "connection refused by upstream"';
    const cut = shortQuery(expr, 40);
    expect(cut).toBe('{app="checkout api server",…');
    expect(shortQuery('{app="checkout api server"}', 14)).toBe("{…");
    expect(shortQuery("rate(some_metric_name_that_is_long_without_any_break_at_all_here)", 20)).toBe("rate(…");
    expect(shortQuery("some_metric_name_that_is_long_without_any_break_at_all", 20)).toBe("some_metric_name_th…");
  });
});
