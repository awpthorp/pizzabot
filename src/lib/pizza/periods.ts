export type PeriodKind = "week" | "month" | "all";
export type Period = {
  kind: PeriodKind;
  start: Date | null;
  end: Date | null;
  due: Date | null;
  key: string;
  label: string;
};
const HOUR = 3_600_000,
  DAY = 24 * HOUR,
  DUBAI_OFFSET = 4 * HOUR;
export function period(kind: PeriodKind, now = new Date()): Period {
  if (kind === "all")
    return {
      kind,
      start: null,
      end: null,
      due: null,
      key: "all",
      label: "All time",
    };
  const dubai = new Date(now.getTime() + DUBAI_OFFSET);
  let start: Date, end: Date;
  if (kind === "week") {
    const today = Date.UTC(
      dubai.getUTCFullYear(),
      dubai.getUTCMonth(),
      dubai.getUTCDate(),
    );
    let cutoff =
      today - ((dubai.getUTCDay() + 2) % 7) * DAY + 16 * HOUR - DUBAI_OFFSET;
    if (cutoff > now.getTime()) cutoff -= 7 * DAY;
    start = new Date(cutoff);
    end = new Date(cutoff + 7 * DAY);
  } else {
    start = new Date(
      Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth(), 1) - DUBAI_OFFSET,
    );
    end = new Date(
      Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth() + 1, 1) -
        DUBAI_OFFSET,
    );
  }
  return boundedPeriod(kind, start, end);
}
function boundedPeriod(kind: "week" | "month", start: Date, end: Date): Period {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return {
    kind,
    start,
    end,
    due: new Date(end.getTime() + (kind === "month" ? 10 * HOUR : 0)),
    key: `${kind}:${start.toISOString()}`,
    label: `${formatter.format(start)} → ${formatter.format(end)} Asia/Dubai (end exclusive)`,
  };
}
export function latestDue(kind: "week" | "month", now = new Date()): Period {
  const current = period(kind, now);
  if (kind === "week")
    return boundedPeriod(
      kind,
      new Date(current.start!.getTime() - 7 * DAY),
      current.start!,
    );
  let end = current.start!;
  if (now.getTime() < end.getTime() + 10 * HOUR)
    end = period("month", new Date(end.getTime() - 1)).start!;
  const start = period("month", new Date(end.getTime() - 1)).start!;
  return boundedPeriod(kind, start, end);
}
export function rankStandings<T extends { slices: number; user_id: string }>(
  rows: T[],
): (T & { rank: number })[] {
  const sorted = [...rows].sort(
    (a, b) => b.slices - a.slices || a.user_id.localeCompare(b.user_id),
  );
  let rank = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row.slices !== sorted[index - 1].slices)
      rank = index + 1;
    return { ...row, rank };
  });
}
