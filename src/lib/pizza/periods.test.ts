import { describe, it, expect } from "vitest";
import { period, latestDue, rankStandings } from "./periods";
describe("original-message report periods", () => {
  it("changes weeks precisely at Friday 16 Dubai, not UTC midnight", () => {
    const before = period("week", new Date("2026-10-09T11:59:59.999Z")),
      at = period("week", new Date("2026-10-09T12:00:00Z"));
    expect(before.start!.toISOString()).toBe("2026-10-02T12:00:00.000Z");
    expect(before.end).toEqual(at.start);
    expect(at.end!.toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(at.label).toContain("16:00");
    expect(at.label).toContain("Asia/Dubai");
    expect(latestDue("week", at.start!).end).toEqual(at.start);
  });
  it("uses Dubai calendar month and year transitions", () => {
    const p = period("month", new Date("2026-12-31T20:00:00Z"));
    expect(p.start!.toISOString()).toBe("2026-12-31T20:00:00.000Z");
    expect(p.end!.toISOString()).toBe("2027-01-31T20:00:00.000Z");
    expect(period("month", new Date("2026-12-31T19:59:59.999Z")).end).toEqual(
      p.start,
    );
  });
  it("monthly completion becomes due at 10 Dubai on the first, selecting only latest due", () => {
    const before = latestDue("month", new Date("2027-01-01T05:59:59Z"));
    expect(before.start!.toISOString()).toBe("2026-10-31T20:00:00.000Z");
    const at = latestDue("month", new Date("2027-01-01T06:00:00Z"));
    expect(at.start!.toISOString()).toBe("2026-11-30T20:00:00.000Z");
    expect(at.end!.toISOString()).toBe("2026-12-31T20:00:00.000Z");
    expect(at.due!.toISOString()).toBe("2027-01-01T06:00:00.000Z");
  });
  it("all time is unbounded and competition ranks share ties (1,1,3)", () => {
    expect(period("all").start).toBeNull();
    expect(period("all").end).toBeNull();
    expect(
      rankStandings([
        { user_id: "U3", slices: 2 },
        { user_id: "U2", slices: 4 },
        { user_id: "U1", slices: 4 },
      ]),
    ).toEqual([
      { user_id: "U1", slices: 4, rank: 1 },
      { user_id: "U2", slices: 4, rank: 1 },
      { user_id: "U3", slices: 2, rank: 3 },
    ]);
  });
});
