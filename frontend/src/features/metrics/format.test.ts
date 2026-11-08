import { describe, expect, it } from "vitest";
import { formatCpu } from "./format";

describe("formatCpu", () => {
  it("keeps millicores below ten cores and one decimal above", () => {
    expect(formatCpu(110)).toBe("110m");
    expect(formatCpu(10_500)).toBe("10.5 cores");
    expect(formatCpu(16_000)).toBe("16.0 cores");
  });
});
