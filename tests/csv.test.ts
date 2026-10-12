import { describe, it, expect } from "vitest";
import { toCsv } from "../src/lib/csv.js";

describe("toCsv", () => {
  it("joins headers and rows", () => {
    const csv = toCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("escapes commas, quotes, and newlines", () => {
    const csv = toCsv(["name"], [['Smith, John'], ['He said "hi"'], ["line\nbreak"]]);
    expect(csv).toContain('"Smith, John"');
    expect(csv).toContain('"He said ""hi"""');
    expect(csv).toContain('"line\nbreak"');
  });

  it("renders null/undefined as empty", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,");
  });
});
