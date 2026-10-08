export type AwardInput = {
  giver: string;
  recipients: string[];
  amount: number;
  total: number;
  channel: string;
  ts: string;
  thread: string;
  reason: string;
};
export function cleanText(text: string): string {
  return text
    .replace(/(^|\n)\s*(?:>>>|&gt;&gt;&gt;)[\s\S]*$/g, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*(?:`|(?=\n)|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(>|&gt;)/.test(line))
    .join("\n");
}
export function parseAward(
  event: Record<string, unknown>,
  channel: string,
): AwardInput | null {
  if (
    event.type !== "message" ||
    event.channel !== channel ||
    event.subtype ||
    event.bot_id ||
    event.app_id ||
    event.attachments ||
    typeof event.user !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(event.user) ||
    typeof event.ts !== "string" ||
    !/^\d{10}\.\d{1,6}$/.test(event.ts) ||
    typeof event.text !== "string"
  )
    return null;
  const reason = cleanText(event.text),
    amount = (reason.match(/🍕\uFE0F?|:pizza:/g) ?? []).length;
  const recipients = [
    ...new Set(
      [...reason.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]),
    ),
  ].sort();
  if (!amount || !recipients.length) return null;
  return {
    giver: event.user,
    recipients,
    amount,
    total: amount * recipients.length,
    channel,
    ts: event.ts,
    thread:
      typeof event.thread_ts === "string" &&
      /^\d{10}\.\d{1,6}$/.test(event.thread_ts)
        ? event.thread_ts
        : event.ts,
    reason: reason.slice(0, 3000),
  };
}
