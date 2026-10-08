import { type PizzaConfig } from "./config";
import { type PizzaStore } from "./store";
import { type PizzaSlack } from "./slack";
import { type Period, latestDue } from "./periods";
export type Standing = {
  user_id: string;
  slices: number;
  rank: number;
  teammates?: number;
};
export type Highlight = {
  id: string;
  channel: string;
  ts: string;
  recipient: string;
  reason: string;
};
export type CelebrationSnapshot = {
  received: Standing[];
  given: Standing[];
  messages: number;
  slices: number;
  givers: number;
  recipients: number;
  participants: number;
  highlights: Highlight[];
};
export type LinkedHighlight = Highlight & { url: string };
export async function linkedHighlights(
  api: PizzaSlack,
  snapshot: CelebrationSnapshot,
): Promise<LinkedHighlight[]> {
  const result: LinkedHighlight[] = [];
  const candidates = [...snapshot.highlights];
  // A bounded number of attempts; missing links never strand the celebration.
  for (
    let attempt = 0;
    attempt < 4 && candidates.length && result.length < 2;
    attempt++
  ) {
    const different = result.length
      ? candidates.findIndex((h) => h.recipient !== result[0].recipient)
      : 0;
    const [candidate] = candidates.splice(different < 0 ? 0 : different, 1);
    const url = await api.permalink(candidate.channel, candidate.ts);
    if (url) result.push({ ...candidate, url });
  }
  return result;
}
function winners(rows: Standing[], label: string): string {
  if (!rows.length) return "";
  const top = rows.filter((row) => row.slices === rows[0].slices);
  return `${label}${top.length > 1 ? ` (co-winners: ${top.length})` : ""}: ${top.map((row) => `<@${row.user_id}>${row.teammates !== undefined ? ` (${row.teammates} teammates thanked)` : ""}`).join(", ")} — ${rows[0].slices} slices.`;
}
export function celebrationText(
  p: Period,
  snapshot: CelebrationSnapshot,
  preview = false,
): string {
  const title = preview
    ? `Private current ${p.kind} preview`
    : p.kind === "week"
      ? "Weekly pizza celebration"
      : "Monthly pizza celebration";
  const header = `🍕 ${title}\n${p.label}\n`;
  if (!snapshot.messages)
    return `${header}No recognition this period yet. Thanks for being part of the team — share a slice of appreciation when a teammate helps you.`;
  return [
    header,
    `${snapshot.slices} slices shared across ${snapshot.messages} recognition messages. ${snapshot.givers} people gave thanks; ${snapshot.recipients} teammates received recognition (${snapshot.participants} people involved).`,
    winners(snapshot.received, "🏆 Pizza champion · most recognised"),
    winners(snapshot.given, "🙌 Top giver"),
    "Received podium (shared ranks):\n" +
      snapshot.received
        .filter((row) => row.rank <= 3)
        .map((row) => `${row.rank}. <@${row.user_id}> — ${row.slices} slices`)
        .join("\n"),
    "Thank you for recognising each other! Explore /pizza rewards and track your next goal.",
  ].join("\n\n");
}
export function celebrationPayload(
  p: Period,
  snapshot: CelebrationSnapshot,
  highlights: LinkedHighlight[],
  preview = false,
): Record<string, unknown> {
  // Only trusted counters/IDs use mrkdwn. Actual recognition excerpts are literal plain_text.
  const summary = celebrationText(p, snapshot, preview);
  const blocks: Record<string, unknown>[] = [];
  for (
    let offset = 0;
    offset < Math.min(summary.length, 36_000);
    offset += 2800
  )
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: summary.slice(offset, offset + 2800) },
    });
  for (const h of highlights.slice(0, 2)) {
    const quote = h.reason
      .replace(
        /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
    blocks.push({
      type: "section",
      text: {
        type: "plain_text",
        text: `Real recognition excerpt: ${quote.slice(0, 240)}${quote.length > 240 ? "…" : ""}`,
      },
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `For <@${h.recipient}> · <${h.url}|View recognition>`,
        },
      ],
    });
  }
  return { text: summary.slice(0, 39_000), blocks };
}
export async function scheduleCelebrations(
  s: PizzaStore,
  api: PizzaSlack,
  c: PizzaConfig,
  now = new Date(),
): Promise<number> {
  if (!c.enabled || !c.celebrationsEnabled || !c.celebrationsStartAt) return 0;
  let queued = 0;
  for (const kind of ["week", "month"] as const) {
    const p = latestDue(kind, now);
    if (
      p.due!.getTime() < c.celebrationsStartAt.getTime() ||
      p.due!.getTime() > now.getTime()
    )
      continue;
    if (!(await s.celebrationReady(c.team, p))) continue;
    const snapshot = await s.celebrationSnapshot(c.team, p);
    const highlights = await linkedHighlights(api, snapshot);
    if (
      await s.queueCelebration(
        c.team,
        p,
        snapshot.messages,
        celebrationPayload(p, snapshot, highlights),
        c.recognitionChannel,
      )
    )
      queued++;
  }
  return queued;
}
