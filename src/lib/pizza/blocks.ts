export const help =
  "Give recognition in the pizza channel: <@USER> 🍕 thanks! Every unique direct mention receives the total pizzas in the text: @Mike @Sarah 🍕🍕 costs four. Five to give per Dubai calendar day; receiving never replenishes giving. No self gifts, guests, bots, external users, code, quotes, attachments, edits or reactions. Original thread replies count. Editing/deleting an accepted message does not alter points. Redemption spends available points but never lifetime earned. /pizza balance | leaderboard [month|all] | rewards | help. Admins: /pizza admin.";
type Reward = {
  id: string;
  name: string;
  cost: number;
  description: string;
  active: boolean;
  stock: number | null;
};
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
          : "Rewards: choose a reward to confirm redemption.",
      ),
    },
    ...(admin
      ? [
          {
            type: "actions",
            elements: [button("Add reward", "pizza_add", "new")],
          },
        ]
      : []),
    ...rewards.slice(0, 20).flatMap((r) => [
      {
        type: "section",
        text: plain(
          `${r.name} — ${r.cost} 🍕\n${r.description}\n${r.stock === null ? "Unlimited stock" : `${r.stock} available`}${r.active ? "" : " (archived)"}`,
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
          : [button("Redeem", "pizza_redeem", r.id)],
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
        text: `Request ${id}\nStaff: <@${user}>\nReward: ${escapeSlackText(name)}\nCharged: ${cost} 🍕\n${escapeSlackText(description.slice(0, 400))}`,
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
          `${r.name}\nCost: ${r.cost} 🍕\nAvailable: ${balance} 🍕\nAfter redemption: ${balance - r.cost} 🍕\n${r.description}`,
        ),
      },
    ],
  };
}
export function rewardModal(r?: Reward) {
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
  return {
    type: "modal" as const,
    callback_id: "pizza_catalogue",
    private_metadata: r?.id ?? "new",
    title: plain(r ? "Edit reward" : "Add reward"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks: [
      input("name", "Name", r?.name ?? ""),
      input("cost", "Pizza cost", r ? String(r.cost) : ""),
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
