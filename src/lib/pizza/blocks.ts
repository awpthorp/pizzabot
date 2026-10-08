import { TIERS, tierLabel, progressMeter, type Tier } from "./rewards";
import type { Reward } from "./store";
import {
  DEFAULT_SETTINGS,
  presetCosts,
  settingsSummary,
  type PizzaSettings,
} from "./settings";
export function help(settings: PizzaSettings = DEFAULT_SETTINGS) {
  return `Give recognition in the pizza channel: <@USER> 🍕 thanks! Every unique direct mention receives the total pizzas in the text: @Mike @Sarah 🍕🍕 costs four. ${settings.dailyLimit} to give per Dubai calendar day${settings.dailyLimit === 0 ? " (giving paused)" : ""}; receiving never replenishes giving. No self gifts, guests, bots, external users, code, quotes, attachments, edits or reactions. Original thread replies count. Editing/deleting an accepted message does not alter earned slices. One received 🍕 is one slice. Redemption spends available slices but never lifetime earned. /pizza balance | leaderboard [week|month|all] [received|given] | rewards | goal clear | help. Use /pizza leaderboard share [week|month|all] [received|given] in the pizza channel to post standings publicly. Other command replies stay private. Track a reward for personal progress; tracking never spends slices. Admins: /pizza admin settings | history [page] | preview [week|month].`;
}
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
export function rewardsBlocks(
  rewards: Reward[],
  admin = false,
  settings: PizzaSettings = DEFAULT_SETTINGS,
) {
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
              ...Object.entries(presetCosts(settings)).map(([tier, cost]) =>
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
export function rewardModal(
  r?: Reward,
  preset?: Tier,
  settings: PizzaSettings = DEFAULT_SETTINGS,
) {
  const costs = presetCosts(settings);
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
        : `${tierLabel(tier as Tier)} (guide: ${costs[tier as Tier]} slices)`,
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
        r ? String(r.cost) : preset ? String(costs[preset]) : "",
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

export function goalText(
  balance: number,
  reward: Reward | null,
  settings: PizzaSettings = DEFAULT_SETTINGS,
): string {
  if (!reward)
    return `Reward tiers: Small ${settings.smallCost} slices · Medium ${settings.mediumCost} slices · Large ${settings.largeCost} slices. Admins choose the actual prizes; costs may be customised. Use /pizza rewards to track a reward.`;
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

export function adminControls() {
  return {
    type: "actions",
    elements: [
      button("Manage settings", "pizza_settings", "open"),
      button("Adjust balance", "pizza_adjust", "open"),
    ],
  };
}
export function settingsBlocks(settings: PizzaSettings) {
  return [
    { type: "section", text: plain(settingsSummary(settings)) },
    adminControls(),
  ];
}
const modalInput = (id: string, label: string, value?: string) => ({
  type: "input",
  block_id: id,
  label: plain(label),
  element: {
    type: "plain_text_input",
    action_id: "value",
    ...(value !== undefined ? { initial_value: value } : {}),
  },
});
export function settingsModal(settings: PizzaSettings) {
  const toggle = (id: string, label: string, enabled: boolean) => {
    const options = [
      { text: plain("On"), value: "on" },
      { text: plain("Off"), value: "off" },
    ];
    return {
      type: "input",
      block_id: id,
      label: plain(label),
      element: {
        type: "static_select",
        action_id: "value",
        options,
        initial_option: options[enabled ? 0 : 1],
      },
    };
  };
  return {
    type: "modal" as const,
    callback_id: "pizza_settings_save",
    private_metadata: String(settings.version),
    title: plain("Manage settings"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: plain(
          "Changes affect subsequently processed recognition. Used allowance stays consumed. Presets affect new prizes only; existing prices stay unchanged. Weekly reports run Friday 4pm Dubai; monthly reports run on the first day at 10am Dubai. Already queued messages may still arrive.",
        ),
      },
      modalInput(
        "dailyLimit",
        "Daily giving limit (0–1000)",
        String(settings.dailyLimit),
      ),
      ...(["smallCost", "mediumCost", "largeCost"] as const).map((k) =>
        modalInput(
          k,
          `${k.slice(0, -4)} preset slices (1–1000000)`,
          String(settings[k]),
        ),
      ),
      toggle("weeklyEnabled", "Weekly celebrations", settings.weeklyEnabled),
      toggle("monthlyEnabled", "Monthly celebrations", settings.monthlyEnabled),
    ],
  };
}
export function adjustmentModal() {
  return {
    type: "modal" as const,
    callback_id: "pizza_adjust_save",
    title: plain("Adjust balance"),
    submit: plain("Apply"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: plain(
          "Adjust available slices only, without changing earned recognition, leaderboards or giving allowance. Enter a signed nonzero integer (±1000000 maximum). The selected staff member and admin receive a private receipt with the reason.",
        ),
      },
      {
        type: "input",
        block_id: "recipient",
        label: plain("Staff recipient"),
        element: {
          type: "users_select",
          action_id: "value",
          placeholder: plain("Choose eligible staff"),
        },
      },
      modalInput("delta", "Slice adjustment (+ or -)"),
      {
        ...modalInput("reason", "Reason (required, up to 500 characters)"),
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          min_length: 1,
          max_length: 500,
        },
      },
    ],
  };
}
export function historyBlocks(rows: Record<string, unknown>[], page: number) {
  const compact = (value: unknown) => {
    const v = value as PizzaSettings;
    return `Giving ${v.dailyLimit}/day · presets ${v.smallCost}/${v.mediumCost}/${v.largeCost} slices · weekly ${v.weeklyEnabled ? "on" : "off"} · monthly ${v.monthlyEnabled ? "on" : "off"}`;
  };
  return [
    {
      type: "section",
      text: plain(
        `Admin history · page ${page}. /pizza admin history [page] (pages start at 0).`,
      ),
    },
    ...rows.flatMap((r) => [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            r.kind === "settings"
              ? `<@${r.actor}> updated settings · ${new Date(String(r.created_at)).toISOString()}`
              : `<@${r.actor}> adjusted <@${r.recipient}>'s available slices: ${r.before_balance} → ${r.after_balance} (${Number(r.delta) > 0 ? "+" : ""}${r.delta}) · ${new Date(String(r.created_at)).toISOString()}`,
        },
      },
      {
        type: "section",
        text: plain(
          r.kind === "settings"
            ? `Before: ${compact(r.old_values)}\nAfter: ${compact(r.new_values)}`
            : `Reason: ${r.reason}`,
        ),
      },
      { type: "context", elements: [plain(`Reference: ${r.job_id}`)] },
    ]),
    ...(rows.length
      ? []
      : [{ type: "section", text: plain("No admin history on this page.") }]),
  ];
}
