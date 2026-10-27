import { describe, it, expect } from "vitest";
import { joinedStatus, meetingWindow, secondsInWindow, statusAfterTimes } from "../src/services/meetingMath.js";

const t = (hhmm: string) => new Date(`2026-10-27T${hhmm}:00Z`);
const start = t("10:00");
const end = t("11:00");
const now = t("12:00");

describe("secondsInWindow", () => {
  it("clips sessions to the meeting window", () => {
    const s = [{ joinedAt: t("09:30"), leftAt: t("10:30") }, { joinedAt: t("10:50"), leftAt: t("11:30") }];
    expect(secondsInWindow(s, start, end, now)).toBe(40 * 60);
  });
  it("merges overlapping sessions instead of double counting", () => {
    const s = [{ joinedAt: t("10:00"), leftAt: t("10:40") }, { joinedAt: t("10:20"), leftAt: t("10:50") }];
    expect(secondsInWindow(s, start, end, now)).toBe(50 * 60);
  });
  it("counts an open session up to now (or the window end)", () => {
    expect(secondsInWindow([{ joinedAt: t("10:30"), leftAt: null }], start, end, t("10:45"))).toBe(15 * 60);
    expect(secondsInWindow([{ joinedAt: t("10:30"), leftAt: null }], start, end, now)).toBe(30 * 60);
  });
  it("is 0 with no sessions or sessions outside the window", () => {
    expect(secondsInWindow([], start, end, now)).toBe(0);
    expect(secondsInWindow([{ joinedAt: t("11:10"), leftAt: t("11:20") }], start, end, now)).toBe(0);
  });
});

describe("meetingWindow", () => {
  it("is [startAt, startAt + durationMin]", () => {
    expect(meetingWindow({ startAt: start, durationMin: 45 }).end.toISOString()).toBe("2026-10-27T10:45:00.000Z");
  });
});

describe("statusAfterTimes — the 70 % rule", () => {
  it("joined but under 70 % of the duration → left_early", () => {
    expect(statusAfterTimes("present", 41 * 60, 60)).toBe("left_early");
    expect(statusAfterTimes("late", 10 * 60, 60)).toBe("left_early");
  });
  it("exactly 70 % or more keeps present / late", () => {
    expect(statusAfterTimes("present", 42 * 60, 60)).toBe("present");
    expect(statusAfterTimes("late", 60 * 60, 60)).toBe("late");
  });
  it("never touches absent or excused", () => {
    expect(statusAfterTimes("absent", 0, 60)).toBe("absent");
    expect(statusAfterTimes("excused", 0, 60)).toBe("excused");
  });
  it("joinedStatus rebuilds present / late / left_early from stored numbers", () => {
    expect(joinedStatus(0, 3600, 60)).toBe("present");
    expect(joinedStatus(12, 3000, 60)).toBe("late");
    expect(joinedStatus(12, 600, 60)).toBe("left_early");
  });
});
