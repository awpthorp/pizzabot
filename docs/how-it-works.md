# PizzaBot, explained simply

PizzaBot is Grassroots' thank-you and rewards system. Everything staff and reward admins do happens in Slack. It does not require staff to open a separate website.

However, Slack does not run our custom code or keep our slice balances. PizzaBot has its own small application and database on Railway. Slack is the front door; that application does the checking, counting and scheduling.

## Where each part lives

| Part | What it does |
| --- | --- |
| PizzaBot in Slack | Accepts thank-you messages in `#pizza`, opens `/pizza` menus and posts celebrations. |
| PizzaBot backend on Railway | Checks permissions and allowances, awards slices, processes rewards and prepares reports. |
| PizzaBot's own Postgres database | Remembers balances, accepted recognition, prizes, requests, goals and admin history. |
| Railway worker, every five minutes | Checks for work that needs finishing and reports that are due. |
| Grassroots staff dashboard | Publishes the [staff handbook](https://dash.gr.agency/handbook). It does not run PizzaBot or store its balances. |
| Grassroots Assistant / Brain | Learns the PizzaBot instructions from the handbook. It can explain how to use PizzaBot; `/pizza` shows current balances, prizes and settings. |

PizzaBot uses a separate Slack app, GitHub repository, Railway project and database. It does not depend on an AI model. Changes to a dashboard handbook page do not change PizzaBot's rules or balances.

## Giving and receiving

In `#pizza`, write a real thank-you with a direct mention and a pizza:

```text
@Mike 🍕 Thanks for helping with the shoot today!
```

Mike earns one slice, and you use one of your daily giving allowance. `@Mike @Sarah 🍕🍕` gives two slices to each person and uses four of your allowance. Both literal 🍕 and Slack's `:pizza:` work. Duplicate mentions count once.

The launch default is five pizzas to give per Dubai calendar day, including weekends. Admins can change it. Unused allowance expires at midnight. Received slices do not refill your giving allowance.

| Number | Meaning |
| --- | --- |
| Remaining to give today | How many more slices you can give out today. |
| Lifetime earned | Recognition received over time. Spending does not reduce it. |
| Available slices | What you can spend on rewards. Redemptions and admin corrections affect this. |

Original messages and original thread replies in `#pizza` count. Reactions, quoted/copied message blocks, code, attachments, edits and deleted messages do not create or undo awards. Self gifts, ineligible people and an over-budget message are rejected as a whole.

## Rewards and goals

Use `/pizza rewards` to see the current catalogue. Track reward saves a personal goal and shows your progress; it spends nothing and reserves no stock. `/pizza goal clear` removes it.

Redeem opens a confirmation. Confirming spends the displayed slice cost and creates a request in private `#pizza-rewards-admin`. An admin arranges the prize outside the bot, then marks it Fulfilled. Cancel/refund returns the slices once. A fulfilled request cannot be cancelled.

Small, Medium and Large are editable reward labels. Their launch preset costs are 6, 8 and 12 slices. They do not promise a particular prize or mean a physical pizza size. Admins choose each reward's name, actual slice cost, description and optional stock. Changing a preset does not change existing rewards; edit a reward to change its price.

## Leaderboards and celebrations

`/pizza leaderboard` shows this month's received slices. Add `week`, `month` or `all`, and optionally `given`, for example `/pizza leaderboard week given`. Giving standings also show how many different teammates each person thanked. Ties share a rank.

The weekly celebration covers Friday 16:00 to the next Friday 16:00 Dubai time. The next five-minute worker run posts the completed week's wrap-up after Friday 16:00. The monthly wrap-up is due after 10:00 Dubai on the first day of the next month. Admins can switch each report off separately.

Wrap-ups celebrate the top receivers and givers, including tied winners, show team totals and can include two real thank-you excerpts with links. Winning a leaderboard does not automatically award a prize. Rewards still use the catalogue and redemption process.

## What admins can change themselves

Alex and Georgia are the launch reward admins. These permissions are configured for PizzaBot and are separate from a Slack workspace admin role.

Open `/pizza admin` for reward and request controls. Use `/pizza admin settings` to change the daily giving limit, the three preset costs and weekly/monthly report switches. Use Adjust balance for a signed slice correction with a reason. Corrections change available slices only; they do not rewrite recognition scores or giving allowance. `/pizza admin history` shows settings changes and corrections.

Admin changes apply going forward. A lower daily limit does not undo pizzas already given; a higher limit adds only the unused difference. Setting the limit to zero pauses giving. Prizes can be added, edited, archived and reactivated without a code change.

Workspace/channel selection, who is an admin, eligibility restrictions, timezone, exact report times, credentials and hosting remain technical configuration. A developer changes those in the backend settings.

## If something seems wrong

Check `/pizza balance` or `/pizza admin requests` before repeating an action. The bot keeps accounting once even when Slack retries a request. A delayed notification does not mean the slices were not recorded. Admins can inspect ambiguous notifications in `/pizza admin`; an operator checks Slack before retrying an uncertain delivery.

For implementation, deployment and recovery details, see [Technical architecture](architecture.md) and the [repository README](../README.md).
