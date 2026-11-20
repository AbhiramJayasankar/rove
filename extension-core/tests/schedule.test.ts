import { describe, expect, it } from "vitest";
import { nextRunAfter, scheduleName } from "../schedule";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("schedule times", () => {
  it("runs a one-off only while it is in the future", () => {
    expect(nextRunAfter({ kind: "once", at: at(2026, 11, 21, 9) }, at(2026, 11, 20))).toBe(at(2026, 11, 21, 9));
    expect(nextRunAfter({ kind: "once", at: at(2026, 11, 21, 9) }, at(2026, 11, 21, 9))).toBeUndefined();
  });
  it("finds the next chosen day at the chosen time", () => {
    // 20 Nov 2026 is a Friday.
    const weekdays = { kind: "days" as const, time: "09:30", days: [1, 2, 3, 4, 5] };
    expect(nextRunAfter(weekdays, at(2026, 11, 20, 8))).toBe(at(2026, 11, 20, 9, 30));
    expect(nextRunAfter(weekdays, at(2026, 11, 20, 9, 30))).toBe(at(2026, 11, 23, 9, 30));
    expect(nextRunAfter({ kind: "days", time: "07:05", days: [0, 1, 2, 3, 4, 5, 6] }, at(2026, 11, 20, 23))).toBe(at(2026, 11, 21, 7, 5));
    expect(nextRunAfter({ kind: "days", time: "07:05", days: [] }, at(2026, 11, 20))).toBeUndefined();
    expect(() => nextRunAfter({ kind: "days", time: "25:00", days: [1] }, 0)).toThrow(/HH:MM/);
  });
  it("repeats every few hours from its start", () => {
    const start = at(2026, 11, 20, 10);
    const every3 = { kind: "hours" as const, hours: 3, start };
    expect(nextRunAfter(every3, at(2026, 11, 20, 9))).toBe(start);
    expect(nextRunAfter(every3, start)).toBe(at(2026, 11, 20, 13));
    expect(nextRunAfter(every3, at(2026, 11, 20, 14, 59))).toBe(at(2026, 11, 20, 16));
  });
  it("names a schedule after its prompt when it has no name", () => {
    expect(scheduleName({ name: "", prompt: "Check the weather\nand tell me" })).toBe("Check the weather\nand tell me".split("\n")[0]);
    expect(scheduleName({ name: " Morning ", prompt: "x" })).toBe("Morning");
  });
});
