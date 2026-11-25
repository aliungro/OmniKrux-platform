import { describe, expect, it } from "vitest";
import {
  ALL_PATTERN,
  escapeQueryString,
  escapeRegex,
  interpolate,
  loneReturnWords,
  VariableError,
} from "./interpolate";

const B = { stepSeconds: 30, rangeSeconds: 21600 };

describe("interpolate", () => {
  it("escapes values for their string", () => {
    const vars = {
      ns: { multi: true, value: ["a.b", "c"] },
      one: { multi: false, value: ['a"} or up{x="'] },
    };
    expect(interpolate('{ns=~"$ns"}', vars, B)).toBe('{ns=~"a\\\\.b|c"}');
    expect(interpolate('{x="${one}"}', vars, B)).toBe('{x="a\\"} or up{x=\\""}');
    expect(interpolate('{ns=~"$ns"}', { ns: { multi: true, value: "all" } }, B)).toBe('{ns=~".+"}');
    expect(interpolate('{ns=~"$ns"}', { ns: { multi: true, value: [] } }, B)).toBe('{ns=~".+"}');
    // Four steps win once they pass the four-minute floor.
    expect(
      interpolate("rate(x[$__rate_interval])", {}, { stepSeconds: 120, rangeSeconds: 21600 }),
    ).toBe("rate(x[8m])");
    expect(interpolate('{a=~"^b$|c"} $nope', {}, B)).toBe('{a=~"^b$|c"} $nope');
  });

  it("builtins", () => {
    expect(interpolate("$__interval $__range", {}, B)).toBe("30s 6h");
    // A tiny step still gets four minutes: four samples at a one-minute scrape.
    expect(interpolate("[$__rate_interval]", {}, { stepSeconds: 5, rangeSeconds: 60 })).toBe(
      "[4m]",
    );
    // Where both terms meet.
    expect(interpolate("[$__rate_interval]", {}, { stepSeconds: 60, rangeSeconds: 3600 })).toBe(
      "[4m]",
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
      '"$a" "$b"',
      { a: { multi: false, value: ["$b"] }, b: { multi: false, value: ["X"] } },
      B,
    );
    expect(out).toBe('"$b" "X"');
  });

  it("inherited names are not variables", () => {
    expect(interpolate("$constructor", {}, B)).toBe("$constructor");
  });

  const one = (value: string[], multi = false) => ({ v: { multi, value } });
  const REFUSAL = "The value of $v can't be used here. Put $v inside double quotes in the query.";

  it("single quotes escape for a single-quoted string", () => {
    const evil = "x' or vector(1) or y{a='";
    const out = interpolate("{a='$v'}", one([evil]), B);
    expect(out).toBe(String.raw`{a='x\' or vector(1) or y{a=\''}`);
    expect(interpolate("'$v'", one(["a\\b\nc\rd"]), B)).toBe(String.raw`'a\\b\nc\rd'`);
  });

  it("backticks refuse a value with a backtick and pass others raw", () => {
    expect(interpolate("{a=`$v`}", one(['a\\b"c']), B)).toBe('{a=`a\\b"c`}');
    expect(() => interpolate("{a=`$v`}", one(["a`b"]), B)).toThrow(VariableError);
    try {
      interpolate("{a=`$v`}", one(["a`b"]), B);
    } catch (e) {
      expect((e as VariableError).name).toBe("v");
      expect((e as Error).message).toBe(REFUSAL);
    }
  });

  it("unquoted values must be plain", () => {
    expect(interpolate("topk($v, up)", one(["5"]), B)).toBe("topk(5, up)");
    expect(interpolate("up[${v}]", one(["a_b:c.d"]), B)).toBe("up[a_b:c.d]");
    // A hyphen would turn `$v{job="x"}` into a subtraction.
    expect(() => interpolate('$v{job="x"}', one(["up-secret"]), B)).toThrow(VariableError);
    expect(() => interpolate("topk($v, up)", one(["5) or up"]), B)).toThrow(VariableError);
    expect(() => interpolate("topk($v, up)", one(["5", "6"], true), B)).toThrow(VariableError);
    expect(() => interpolate("topk($v, up)", { v: { multi: true, value: "all" } }, B)).toThrow(
      VariableError,
    );
    expect(() => interpolate("topk($v, up)", { v: { multi: false, value: "all" } }, B)).toThrow(
      VariableError,
    );
  });

  it("builtins are allowed anywhere", () => {
    expect(interpolate("rate(x[$__rate_interval]) '$__interval' `$__range`", {}, B)).toBe(
      "rate(x[4m]) '30s' `6h`",
    );
  });

  it("an escaped quote does not end the string scan", () => {
    const out = interpolate('{a="x\\" $v"}', one(['q"r']), B);
    expect(out).toBe('{a="x\\" q\\"r"}');
    // The string closes at the real quote, so a later bare variable is unquoted again.
    expect(() => interpolate('{a="x"} $v', one(["a b"]), B)).toThrow(VariableError);
    // A quote of the other kind inside a string does not change the context.
    expect(interpolate(`"it's $v"`, one(['"']), B)).toBe(`"it's \\""`);
  });

  it("a quote inside a # comment does not flip the string state", () => {
    const evil = 'x"} or vector(1) or up{a="';
    const dbl = interpolate(`up # it's\n{a="$v"}`, one([evil]), B);
    expect(dbl).toBe(`up # it's\n{a="x\\"} or vector(1) or up{a=\\""}`);
    const sgl = interpolate(`up # say "hi\n{a='$v'}`, one(["x' or up{a='"]), B);
    expect(sgl).toBe(`up # say "hi\n{a='x\\' or up{a=\\''}`);
  });

  it("a lone carriage return outside quotes refuses to place a value", () => {
    // PromQL ends the comment at the \r, so the backticks open a string there, and the double
    // quotes that follow are outside it; this scan would see it the other way round.
    const text = "up #\r" + "`" + "\n" + "`" + ' {a="$v"}';
    const evil = 'x"} or vector(1) or up{a="';
    expect(() => interpolate(text, one([evil]), B)).toThrow(VariableError);
    try {
      interpolate(text, one([evil]), B);
    } catch (e) {
      expect((e as VariableError).name).toBe("v");
      expect((e as Error).message).toBe(loneReturnWords("v"));
      expect((e as Error).message).toBe("The query has a carriage return outside quotes, so $v can't be placed safely. Remove it, or start a new line instead.");
    }
    // Outside a comment too.
    expect(() => interpolate('up\r{a="$v"}', one(["x"]), B)).toThrow(VariableError);
    // A Windows line break, a \r inside quotes, or no variable at all: the text goes as it is.
    expect(interpolate('up # c\r\n{a="$v"}', one(["x"]), B)).toBe('up # c\r\n{a="x"}');
    expect(interpolate('{a="\r$v"}', one(["x"]), B)).toBe('{a="\rx"}');
    expect(interpolate("up #\r`\n` {a=\"b\"}", {}, B)).toBe("up #\r`\n` {a=\"b\"}");
    expect(interpolate("rate(up[$__range])\r", {}, B)).toBe("rate(up[6h])\r");
  });

  it("comments are copied as they are and end at the line break", () => {
    expect(interpolate("up # $v $__range\r\n$v", one(["5"]), B)).toBe("up # $v $__range\r\n5");
    expect(interpolate('"a # $v"', one(["q"]), B)).toBe('"a # q"');
  });
});
