import { describe, it, expect } from "vitest";
import { analyse, type AnalysisDay } from "../src/lib/reportAnalysis.js";

const REQ = 5.5 * 3600;
const d = (day: string, status: string, hours = 0, join: number | null = null): AnalysisDay => ({
  day,
  status,
  seconds: Math.round(hours * 3600),
  firstJoinMin: join,
  onTime: join !== null && join <= 14 * 60,
});

describe("analyse", () => {
  it("detects an improving trend and weekly rows", () => {
    const days = [
      d("2026-10-05", "missing"), d("2026-10-06", "missing"), d("2026-10-07", "partial", 3, 900), d("2026-10-08", "missing"),
      d("2026-10-12", "good", 6, 660), d("2026-10-13", "good", 6, 670), d("2026-10-14", "good", 7, 650), d("2026-10-15", "good", 6, 640),
    ];
    const a = analyse({ days, requiredSeconds: REQ, loginByMin: 840, name: "Jai" });
    expect(a.trend.direction).toBe("improving");
    expect(a.weeks.map((w) => w.weekOf)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(a.longestGood).toBe(4);
    expect(a.longestAbsent).toBe(2);
    expect(a.join.lateDays).toBe(1);
    expect(a.paragraphs.find((p) => p.title === "Trend over the period")?.body).toMatch(/improved/);
  });

  it("totals shortfall without letting surplus offset it", () => {
    const days = [d("2026-10-12", "good", 8, 600), d("2026-10-13", "partial", 4.5, 600)];
    const a = analyse({ days, requiredSeconds: REQ, loginByMin: 840, name: "Jai" });
    expect(a.shortfallSeconds).toBe(3600);
    expect(a.surplusSeconds).toBe(2.5 * 3600);
    expect(a.paragraphs.find((p) => p.title === "Hours balance")?.body).toMatch(/do not offset/);
  });

  it("writes a firm conclusion for poor attendance and a positive one for full compliance", () => {
    const bad = analyse({ days: [d("2026-10-12", "missing"), d("2026-10-13", "missing")], requiredSeconds: REQ, loginByMin: 840, name: "A" });
    expect(bad.conclusion).toMatch(/unsatisfactory/);
    const good = analyse({ days: [d("2026-10-12", "good", 6, 600), d("2026-10-13", "good", 6, 600)], requiredSeconds: REQ, loginByMin: 840, name: "B" });
    expect(good.conclusion).toMatch(/meets CyArt's expectations/);
  });

  it("ignores holidays, leave and weekends as working days", () => {
    const days = [d("2026-10-02", "holiday"), d("2026-10-03", "off"), d("2026-10-06", "leave"), d("2026-10-07", "good", 6, 600)];
    const a = analyse({ days, requiredSeconds: REQ, loginByMin: 840, name: "C" });
    expect(a.weekdays.reduce((s, w) => s + w.workdays, 0)).toBe(1);
  });
});
