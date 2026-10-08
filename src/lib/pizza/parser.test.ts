import { describe, it, expect } from "vitest";
import { parseAward } from "./parser";
const event = {
  type: "message",
  channel: "C1",
  user: "U1",
  ts: "1791489600.000001",
  text: "<@U2> 🍕 thanks",
};
const parse = (text: string, overrides = {}) =>
  parseAward({ ...event, text, ...overrides }, "C1");
describe("recognition parsing", () => {
  it("uses emoji count per unique recipient, including labelled and duplicate mentions", () => {
    expect(parse("<@U2|Mike> <@U3> <@U2> 🍕:pizza:")).toMatchObject({
      recipients: ["U2", "U3"],
      amount: 2,
      total: 4,
    });
  });
  it("removes quotes, inline and fenced code without counting blocks", () => {
    expect(
      parse(
        "> <@U4> 🍕\n&gt; <@U5> :pizza:\n`<@U6> 🍕` ```<@U7> 🍕``` <@U2> :pizza:",
      ),
    ).toMatchObject({ recipients: ["U2"], amount: 1 });
  });
  it("excludes multiline quotes and unfinished code blocks", () => {
    expect(parse(">>> quoted\n<@U2> 🍕")).toBeNull();
    expect(parse("```<@U2> 🍕")).toBeNull();
  });
  it("does not count group mentions, reactions or unmatched text", () => {
    for (const text of ["<!here> 🍕", "<@U2> thanks", "🍕", "```<@U2> 🍕```"])
      expect(parse(text)).toBeNull();
  });
  it("ignores edits/system/bot/app/attachments/wrong channel", () => {
    for (const overrides of [
      { subtype: "message_changed" },
      { subtype: "message_deleted" },
      { subtype: "channel_join" },
      { bot_id: "B1" },
      { app_id: "A1" },
      { attachments: [] },
      { channel: "C2" },
    ])
      expect(parse(event.text, overrides)).toBeNull();
  });
  it("uses only text and allows original thread replies, keeping Slack timestamps", () => {
    expect(
      parse(event.text, {
        thread_ts: "1791489500.001",
        blocks: [{ text: "🍕" }],
      }),
    ).toMatchObject({ amount: 1, ts: event.ts, thread: "1791489500.001" });
  });
});
