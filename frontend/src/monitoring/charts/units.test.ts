import { describe, expect, it } from "vitest";
import { UNITS } from "../dashboards/schema";
import { formatValue } from "./units";

describe("formatValue", () => {
  it("formats units in words people read", () => {
    expect(formatValue(0.2134, "s", null)).toBe("213 ms");
    expect(formatValue(1536, "bytes", null)).toBe("1.5 KiB");
    expect(formatValue(0.283, "percentunit", null)).toBe("28.3%");
    expect(formatValue(1400, "reqps", null)).toBe("1.4k req/s");
    expect(formatValue(1, "cores", null)).toBe("1 core");
    expect(formatValue(null, "s", 2)).toBe("–");
  });
  it("covers the rest of the unit list", () => {
    expect(formatValue(1400, "short", null)).toBe("1.4k");
    expect(formatValue(1400, "none", null)).toBe("1.4k");
    expect(formatValue(2_500_000, "short", null)).toBe("2.5M");
    expect(formatValue(7, "short", null)).toBe("7");
    expect(formatValue(28.3, "percent", null)).toBe("28.3%");
    expect(formatValue(1.5, "s", null)).toBe("1.5 s");
    expect(formatValue(150, "s", null)).toBe("2.5 min");
    expect(formatValue(11520, "s", null)).toBe("3.2 h");
    expect(formatValue(850, "ms", null)).toBe("850 ms");
    expect(formatValue(1200, "ms", null)).toBe("1.2 s");
    expect(formatValue(3 * 1024 ** 2, "bytes", null)).toBe("3 MiB");
    expect(formatValue(512, "bytes", null)).toBe("512 B");
    expect(formatValue(1536, "Bps", null)).toBe("1.5 KiB/s");
    expect(formatValue(0.25, "cores", null)).toBe("0.25 cores");
  });
  it("gives three significant digits, or the decimals asked for", () => {
    expect(formatValue(12.3456, "none", null)).toBe("12.3");
    expect(formatValue(123.456, "none", null)).toBe("123");
    expect(formatValue(0.012345, "none", null)).toBe("0.0123");
    expect(formatValue(12.3456, "none", 1)).toBe("12.3");
    expect(formatValue(12, "percent", 2)).toBe("12.00%");
  });
  it("keeps the sign and never prints NaN", () => {
    expect(formatValue(-1400, "short", null)).toBe("-1.4k");
    expect(formatValue(Number.NaN, "short", null)).toBe("–");
  });
  it("rounds before choosing the suffix", () => {
    expect(formatValue(999.7, "short", null)).toBe("1k");
    expect(formatValue(999600, "short", null)).toBe("1M");
    expect(formatValue(999.4, "short", null)).toBe("999");
    expect(formatValue(1023.7, "bytes", null)).toBe("1 KiB");
    expect(formatValue(1024 * 1023.9, "bytes", null)).toBe("1 MiB");
    expect(formatValue(59.99, "s", null)).toBe("1 min");
    expect(formatValue(0.9997, "s", null)).toBe("1 s");
    expect(formatValue(3599.9, "s", null)).toBe("1 h");
    expect(formatValue(999.7, "ms", null)).toBe("1 s");
    expect(formatValue(999.7, "reqps", null)).toBe("1k req/s");
  });
  it("knows every unit", () => {
    for (const u of UNITS) expect(formatValue(1, u, null)).not.toBe("");
  });
});
