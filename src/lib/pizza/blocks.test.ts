import { it, expect } from "vitest";
import { redemptionBlocks } from "./blocks";
it("renders the real staff mention while escaping catalogue-supplied mention markup", () => {
  const blocks = redemptionBlocks(
    "request",
    "U123",
    "Coffee <!here>",
    2,
    "Ask <@U999> & collect",
  );
  const text = JSON.stringify(blocks);
  expect(text).toContain("Staff: <@U123>");
  expect(text).toContain("&lt;!here&gt;");
  expect(text).toContain("&lt;@U999&gt; &amp; collect");
});

it("keeps long escaped catalogue text within Slack's section limits", () => {
  const blocks = redemptionBlocks(
    "request",
    "U123",
    "&".repeat(100),
    2,
    "&".repeat(2000),
  );
  for (const block of blocks) {
    if ("text" in block && block.text)
      expect(block.text.text.length).toBeLessThanOrEqual(3000);
  }
});
