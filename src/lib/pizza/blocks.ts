import {
  TIERS,
  tierLabel,
  progressMeter,
  tierGuide,
  type Tier,
} from "./rewards";
import type { Reward } from "./store";
export const help =
  "Give recognition in the pizza channel: <@USER> 🍕 thanks! Every unique direct mention receives the total pizzas in the text: @Mike @Sarah 🍕🍕 costs four. Five to give per Dubai calendar day; receiving never replenishes giving. No self gifts, guests, bots, external users, code, quotes, attachments, edits or reactions. Original thread replies count. Editing/deleting an accepted message does not alter earned slices. One received 🍕 is one slice. Redemption spends available slices but never lifetime earned. /pizza balance | leaderboard [week|month|all] [received|given] | rewards | goal clear | help. Track a reward for personal progress; tracking never spends slices. Admins: /pizza admin and /pizza admin preview [week|month].";
const plain = (text: string) => ({
  type: "plain_text",
  text: text.slice(0, 2000),
});
export const button = (text: string, action_id: string, value: string) => ({
  type: "button",
  text: plain(text),
  action_id,
  value,
});
export function rewardsBlocks(rewards: Reward[], admin = false) {
  return [
    {
      type: "section",
      text: plain(
        admin
          ? "Reward catalogue"
          : rewards.length
            ? "Rewards: choose a reward to confirm redemption."
            : "No rewards have been configured yet.",
      ),
    },
    ...(admin
      ? [
          {
            type: "actions",
            elements: [
              button("Add custom", "pizza_add", "new"),
              ...Object.entries(TIERS).map(([tier, cost]) =>
                button(
                  `Add ${tierLabel(tier as Tier)} (${cost})`,
                  `pizza_add_${tier}`,
                  "new",
                ),
              ),
            ],
          },
        ]
      : []),
    ...rewards.slice(0, 20).flatMap((r) => [
      {
        type: "section",
        text: plain(
          `${r.name} — ${tierLabel(r.tier)} · ${r.cost} slices\n${r.description}\n${r.stock === null ? "Unlimited stock" : `${r.stock} available`}${r.active ? "" : " (archived)"}`,
        ),
      },
      {
        type: "actions",
        elements: admin
          ? [
              button("Edit", "pizza_edit", r.id),
              button(
                r.active ? "Archive" : "Activate",
                r.active ? "pizza_archive" : "pizza_activate",
                r.id,
              ),
            ]
          : [
              button("Track reward", "pizza_goal", r.id),
              button("Redeem", "pizza_redeem", r.id),
            ],
      },
    ]),
  ];
}
export function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
export function redemptionBlocks(
  id: string,
  user: string,
  name: string,
  cost: number,
  description: string,
) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Request ${id}\nStaff: <@${user}>\nReward: ${escapeSlackText(name)}\nCharged: ${cost} slices\n${escapeSlackText(description.slice(0, 400))}`,
      },
    },
    ...(description.length > 400
      ? [{ type: "section", text: plain(description.slice(400)) }]
      : []),
    {
      type: "actions",
      elements: [
        button("Fulfilled", "pizza_fulfill", id),
        button("Cancel and refund", "pizza_cancel", id),
      ],
    },
  ];
}

export function confirmationModal(intent: string, r: Reward, balance: number) {
  return {
    type: "modal" as const,
    callback_id: "pizza_confirm",
    private_metadata: intent,
    title: plain("Confirm reward"),
    submit: plain("Redeem"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: plain(
          `${r.name}\nCost: ${r.cost} slices\nAvailable: ${balance} slices\nAfter redemption: ${balance - r.cost} slices\n${r.description}`,
        ),
      },
    ],
  };
}
export function rewardModal(r?: Reward, preset?: Tier) {
  const input = (
    id: string,
    label: string,
    value: string,
    optional = false,
  ) => ({
    type: "input",
    block_id: id,
    label: plain(label),
    optional,
    element: {
      type: "plain_text_input",
      action_id: "value",
      ...(value ? { initial_value: value } : {}),
    },
  });
  const selected = r?.tier ?? preset ?? "custom";
  const options = ["custom", ...Object.keys(TIERS)].map((tier) => ({
    text: plain(
      tier === "custom"
        ? "Custom"
        : `${tierLabel(tier as Tier)} (guide: ${TIERS[tier as Tier]} slices)`,
    ),
    value: tier,
  }));
  return {
    type: "modal" as const,
    callback_id: "pizza_catalogue",
    private_metadata: r?.id ?? "new",
    title: plain(r ? "Edit reward" : "Add reward"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      input("name", "Name", r?.name ?? ""),
      {
        type: "input",
        block_id: "tier",
        label: plain("Reward tier"),
        element: {
          type: "static_select",
          action_id: "value",
          options,
          initial_option: options.find((option) => option.value === selected),
        },
      },
      input(
        "cost",
        "Cost in slices (edit explicitly)",
        r ? String(r.cost) : preset ? String(TIERS[preset]) : "",
      ),
      {
        type: "context",
        elements: [
          plain(
            "Changing tier does not change cost. Choose the actual prize name and fulfilment below.",
          ),
        ],
      },
      input(
        "description",
        "Fulfilment description",
        r?.description ?? "",
        true,
      ),
      input(
        "stock",
        "Stock (blank = unlimited)",
        r?.stock == null ? "" : String(r.stock),
        true,
      ),
    ],
  };
}

export function goalText(balance: number, reward: Reward | null): string {
  if (!reward) return tierGuide;
  const availability = !reward.active
    ? "This goal is archived."
    : reward.stock === 0
      ? "This goal is sold out."
      : "";
  const remaining = Math.max(0, reward.cost - balance);
  return [
    `Tracking: ${escapeSlackText(reward.name)} · ${tierLabel(reward.tier)} · current cost ${reward.cost} slices`,
    `${progressMeter(balance, reward.cost)}${reward.cost > 12 ? " (12-cell proportional view)" : " (one cell per slice)"}`,
    `${balance}/${reward.cost} available slices. ${availability || (remaining ? `${remaining} more slices to reach the current cost.` : "Ready to redeem via /pizza rewards.")}`,
    "Tracking never spends or reserves slices. Use /pizza rewards to change your goal or /pizza goal clear to remove it.",
  ].join("\n");
}
