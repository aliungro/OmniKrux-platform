import { describe, expect, it } from "vitest";
import { ALL_PATTERN, escapeQueryString, escapeRegex, interpolate } from "./interpolate";

const B = { stepSeconds: 30, rangeSeconds: 21600 };

describe("interpolate", () => {
  it("escapes values for their string", () => {
    const vars = {
      ns: { multi: true, value: ["a.b", "c"] },
      one: { multi: false, value: ['a"} or up{x="'] },
    };
    expect(interpolate('{ns=~"$ns"}', vars, B)).toBe('{ns=~"a\\\\.b|c"}');
    expect(interpolate('{x="${one}"}', vars, B)).toBe('{x="a\\"} or up{x=\\""}');
    expect(interpolate('{ns=~"$ns"}', { ns: { multi: true, value: "all" } }, B)).toBe(
      '{ns=~".+"}',
    );
    expect(interpolate('{ns=~"$ns"}', { ns: { multi: true, value: [] } }, B)).toBe('{ns=~".+"}');
    expect(
      interpolate("rate(x[$__rate_interval])", {}, { stepSeconds: 30, rangeSeconds: 21600 }),
    ).toBe("rate(x[2m])");
    expect(interpolate('{a=~"^b$|c"} $nope', {}, B)).toBe('{a=~"^b$|c"} $nope');
  });

  it("builtins", () => {
    expect(interpolate("$__interval $__range", {}, B)).toBe("30s 6h");
    expect(interpolate("[$__rate_interval]", {}, { stepSeconds: 5, rangeSeconds: 60 })).toBe(
      "[1m]",
    );
  });

  it("escape helpers", () => {
    expect(escapeQueryString('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    expect(escapeRegex("a.b*c(d)[e]{f}|^$?+\\")).toBe(
      "a\\.b\\*c\\(d\\)\\[e\\]\\{f\\}\\|\\^\\$\\?\\+\\\\",
    );
    expect(ALL_PATTERN).toBe(".+");
  });

  it("a hostile value stays one escaped string", () => {
    const evil = 'x"\\}\nor up{a="';
    const single = interpolate('{a="$v"}', { v: { multi: false, value: [evil] } }, B);
    const body = single.slice('{a="'.length, -'"}'.length);
    // No raw newline survives, and every quote is preceded by an odd run of backslashes.
    expect(body).not.toMatch(/\n/);
    expect(body).not.toMatch(/(^|[^\\])(\\\\)*"/);
    expect(body).toBe('x\\"\\\\}\\nor up{a=\\"');

    const multi = interpolate('{a=~"$v"}', { v: { multi: true, value: [evil, "ok"] } }, B);
    const mbody = multi.slice('{a=~"'.length, -'"}'.length);
    expect(mbody).not.toMatch(/\n/);
    expect(mbody).not.toMatch(/(^|[^\\])(\\\\)*"/);
    // Braces are regex-escaped before string-escaping.
    expect(mbody).toContain("\\\\}");
    expect(mbody.endsWith("|ok")).toBe(true);
  });

  it("a value is never re-expanded", () => {
    const out = interpolate(
      "$a $b",
      { a: { multi: false, value: ["$b"] }, b: { multi: false, value: ["X"] } },
      B,
    );
    expect(out).toBe("$b X");
  });

  it("inherited names are not variables", () => {
    expect(interpolate("$constructor", {}, B)).toBe("$constructor");
  });
});
