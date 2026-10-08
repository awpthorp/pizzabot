# Grassroots PizzaBot

An open-source Slack recognition bot built by [Grassroots Creative Agency](https://gr.agency). Give teammates 🍕, celebrate helpful work and redeem team rewards, all inside Slack. Fork it and run it in your own workspace under the [MIT license](LICENSE).

**Free source code. Self-hosted.** You supply your own Slack app, backend hosting, dedicated PostgreSQL database and prizes. PizzaBot is a standalone Next.js API service, with no dashboard or AI model dependency. This version uses Asia/Dubai for daily resets and reports.

- [Get PizzaBot and see what it does](https://gr.agency/free-tools/pizzabot)
- [Set up your own installation](docs/self-hosting.md)
- [PizzaBot, explained simply](docs/how-it-works.md)
- [Technical architecture](docs/architecture.md)
- [Contribute](CONTRIBUTING.md) · [Report a security issue](SECURITY.md)

## What is in the box?

- Peer recognition with a configurable daily giving allowance.
- Separate lifetime recognition scores and available reward balances.
- Weekly, monthly and all-time leaderboards for giving and receiving, including ties.
- Explicit public leaderboard sharing and automatic weekly/monthly wrap-ups.
- Editable prizes, slice prices, stock, goals and manual fulfilment/refunds.
- Slack admin controls for allowance, size presets, reports and audited balance corrections.
- Signed Slack requests, transaction-based accounting and durable background recovery.

## Recognition policy

The default is five pizzas to give per original message's Asia/Dubai calendar
day, including weekends. Admins can change the daily limit from Slack; the original
message date still determines which day's allowance is consumed. Receiving does not replenish giving. Lifetime earned and available
balance are distinct; one received 🍕 earns one slice. Redemption spends available
slices without changing earned leaderboard scores. Unused giving allowance expires at midnight; no reset job.

Every unique direct mention receives the total pizza count in message text:
`@Mike @Sarah 🍕🍕` gives two each and costs four. Duplicate mentions count once.
Unicode 🍕 and Slack `:pizza:` both count. Code, quotes, group mentions,
attachments, forwarded messages and reactions do not count. Original thread
replies count; edits/deletions never change accepted ledger entries. Self gifts,
invalid recipients and insufficient allowance reject the whole award privately.
Bots, deleted users, guests and external members are ineligible. An optional
participant allowlist can restrict eligible regular members to staff.

Commands: `/pizza` or `balance`, `help`, `leaderboard [week|month|all]
[received|given]`, `rewards`, `goal clear`, and admin-only `admin`. The default
leaderboard is this month's received slices. Given standings count accepted
slices given and distinct teammates thanked. Scores use original Slack message
timestamps, independently of spending. Ties share ranks (1, 1, 3), with stable
Slack ID order within ties. Weeks run Friday 16:00 to the next Friday 16:00 in
Asia/Dubai; months use the Dubai calendar. Every bounded leaderboard prints its
exact dates, including the exclusive end.

`/pizza leaderboard share` posts this month's received standings publicly.
`/pizza leaderboard share week given` shares weekly giving; `month`/`all` and
`received`/`given` also work. `share` can appear first or last among the options.
Sharing must be invoked in the configured public pizza channel by eligible staff.
The top ten rankings show recognition totals, ties and who shared them, without
spendable balances, goals or reward details. Commands without `share` stay private.

`/pizza admin` shows Manage settings, Adjust balance, reward controls, pending
requests, and ambiguous notifications.
`/pizza admin rewards [page]`, `requests [page]`, and `deliveries [page]` show
additional records; pages start at 0. `/pizza admin preview [week|month]` privately
shows the current period to a configured eligible admin, even before celebrations
are enabled. A preview creates no public report or scheduling receipt.

The initial reward catalogue is empty. Admins add/edit/archive rewards via modals,
including positive integer slice cost, fulfilment description and optional stock.
Add Small, Medium and Large open editable presets of 6, 8 and 12 slices; Custom
keeps existing rewards valid. The tier is a label: changing it never silently
changes the entered price. Your configured admins choose the actual names, prizes and stock.
No tier promises a prize and no reward is seeded automatically.

Staff can Track reward from the catalogue, switch goals, or clear a goal from
balance or `/pizza goal clear`. Tracking is available before earning any slices;
it reserves no stock and spends nothing. Balance shows the current price,
available slices, remaining amount or readiness, and current availability. A
small/medium/large progress meter has one cell per required slice; custom costs
above 12 use a fixed 12-cell meter labeled proportional. Archived or sold-out
goals remain visible as unavailable until changed or cleared.

Opening/cancelling a confirmation spends nothing. Submission checks current
eligibility, stock and confirmed price, then debits once and creates a pending
request. Price changes require renewed confirmation. Configured admins receive
admin controls; admins fulfil or cancel/refund pending requests. A fulfilled
request cannot be cancelled. Request names/prices retain their original snapshot.

## Admin flexibility

Configured admins can use `/pizza admin settings` or Manage settings to set the
daily giving limit (0–1000), new Small/Medium/Large preset costs (1–1000000, in
any order), and weekly/monthly celebration switches. Defaults stay 5 per day and
6/8/12 slices, with both report switches on. Preset changes update new modal
defaults and guidance; they never reprice existing prizes or confirmations.

Limits affect awards processed after the settings transaction commits. A shared
settings lock serializes awarding against a save. Already consumed allowance
stays consumed: lowering below usage clamps remaining to zero, raising restores
only the unused difference, and zero pauses new giving while reward/admin controls
remain available. Settings modals carry an optimistic revision so a stale save
asks the admin to refresh instead of overwriting someone else's change. A no-op
save changes no values, revision or history.

Adjust balance opens a staff picker, signed nonzero slice amount (between
-1000000 and +1000000), and required reason up to 500 characters. The worker
freshly checks both admin and recipient eligibility, including staff allowlists.
Corrections change available balance only: earned recognition, leaderboards and
giving allowance stay unchanged. A recipient can receive a correction before
their first award. Negative resulting balances and integer overflow are refused.
The modal's Apply button submits the correction; the admin and recipient receive
private receipts showing who changed what, before/after balances and the reason.
Private refusal feedback from these modals appears in the admin channel.

Account locks serialize corrections with redemption/refunds. The job-derived
adjustment ID deduplicates replays, and the balance change, immutable balance-only
ledger entry, audit, notifications and job completion commit together. Never edit
ledger rows or create a second correction to recover an uncertain notification.
`/pizza admin history [page]` privately shows the latest ten settings changes and
corrections per page, with literal reasons and trusted staff mentions. History
retains actor/time/old/new values and before/after balances after inbox retention;
it contains no response URLs or credentials. Credentials, channel IDs, admin
roles, staff eligibility, timezone and report timing remain server-controlled.

Report switches affect new weekly/monthly reports and are checked again inside
the final queue transaction. Disabling during link lookup prevents a new report;
already queued messages remain deliverable. Re-enabling keeps the original
activation guard and latest-only recovery, with no historical flood. The separate
server enable/activation gates still apply. Private current-period previews remain
available to eligible admins regardless of the individual report switches.

## Local development and checks

Requires Node.js 22+ and Postgres. Copy `.env.example` to `.env.local` and populate
credentials locally (never commit them). Next reads `.env.local`; command-line
migration/worker scripts read process environment, so export their variables or
use `node --env-file=.env.local scripts/migrate.mjs`.

```sh
npm ci
npm run dev
npm run verify
npm run build
```

Use a disposable local database, never production, for actual race/recovery tests:

```sh
PIZZA_TEST_DATABASE_URL=postgresql://localhost/pizza_test npm test -- src/lib/pizza/store.integration.test.ts
DATABASE_URL=postgresql://localhost/pizza_migrate_test npm run migrate
DATABASE_URL=postgresql://localhost/pizza_migrate_test npm run migrate:status
DATABASE_URL=postgresql://localhost/pizza_migrate_test npm run migrate
```

Integration tests refuse remote hosts and create/drop their own isolated schema.
The managed runner applies all SQL files in `db/migrations` in filename order,
under an advisory lock with immutable checksums. The original recognition
migration stays unchanged; celebrations, reward tiers and goals use a new
migration. Repeated apply executes no migration SQL. Never edit a migration after production apply.
`npm run verify` includes unit tests, worker and migration Node tests, and TypeScript.

## Slack installation

Follow [the self-hosting guide](docs/self-hosting.md) to create your own Slack app.
`slack/pizza-manifest.json` uses placeholder `https://pizzabot.example.com` URLs
for events, `/pizza`, and interactivity. Replace all three with your own HTTPS
origin. The Events URL can verify with only `PIZZA_SIGNING_SECRET` configured
while the feature is disabled. Normal mutations fail closed until all
configuration is valid.

Install the app and explicitly invite it into public `#pizza` and private
`#pizza-rewards-admin`. Scopes are `channels:history`, `channels:read`,
`groups:read` (for private admin channel), `chat:write`, `users:read`, `commands`.
No automatic channel joins, email access, reactions, public distribution or
Marketplace submission. Subscribe to `message.channels` and `user_change`.
Upload `assets/pizzabot-icon.png` as the app icon (flat pizza slice generated with
the built-in ImageGen tool). Install a separate app for your own workspace.

Set the names in `.env.example`: all IDs are server configuration; participant
IDs are optional. Set a separate random `PIZZA_WORKER_SECRET` of at least 32
characters, different from the Slack signing secret. App credentials never fall
back to Assistant credentials. Set `PIZZA_ENABLED=true` only after the independent
worker, channels and test checks are ready. Disable it to pause new mutations
while still allowing committed notification delivery and reconciliation.

## Celebrations

The existing authenticated five-minute drain schedules weekly reports after
Friday 16:00 Dubai and monthly reports after 10:00 Dubai on the first day of the
month, covering the previous completed calendar month. The next drain delivers
them; this is not an exact-minute scheduler. Reports celebrate every tied pizza
champion and top giver, show the top three received ranks with ties, team totals,
and up to two genuine saved recognition excerpts linked to their original
messages. Missing/deleted/unavailable links are omitted. Quotes are bounded
literal text; there is no generated praise. Slack's
[chat.getPermalink method](https://docs.slack.dev/reference/methods/chat.getPermalink/)
requires no additional scopes.

Set `PIZZA_CELEBRATIONS_ENABLED=true` and a valid explicit ISO timestamp in
`PIZZA_CELEBRATIONS_START_AT` only at launch. Reports whose due time is earlier
than activation are never scheduled. Missing or invalid activation disables
scheduling while recognition continues. `PIZZA_ENABLED=false` pauses new reports
and mutations; committed deliveries continue. After an outage only the latest
due weekly and monthly periods are considered, avoiding a flood of old reports.

A unique team/period receipt and its stable outbox payload commit together.
Concurrent drains cannot enqueue the same report twice. Pending accepted award
jobs within the period delay its snapshot; the final transaction also rechecks
for newly accepted work. Reports describe the accepted awards at that snapshot:
late Slack events arriving after a report commits do not revise a published post.
Slack permalink requests run outside database locks. Known delivery failures
retry; ambiguous delivery waits for manual review and is never blindly reposted.

Leaderboards and celebrations award no automatic prizes. Rewards are separately
chosen by admins and redeemed using available slices with the existing private
confirmation, stock checks and manual fulfilment/refund process.

## Railway web and worker

Deploy this repository as two services in the PizzaBot project, with its own
managed Postgres service. Configure new Railway services directly in their service
settings (Config as Code files are deprecated for new services). No infrastructure
SDK or IaC apply is needed.

| Setting | Web | Scheduled worker |
| --- | --- | --- |
| Builder | Dockerfile | Dockerfile |
| Dockerfile path | `Dockerfile` | `Dockerfile.worker` |
| Start command | `node server.js` | `node scripts/run-pizza-worker.mjs` |
| Pre-deploy command | `npm run migrate` | None |
| Health check | `/api/health`, 120 second timeout | None |
| Restart policy | ON_FAILURE, 3 retries | NEVER |
| Cron schedule | None | `*/5 * * * *` |

Back up existing PizzaBot data before schema changes. The pre-deploy command runs
the managed migration. `/api/health` is a lightweight readiness endpoint that
reveals no configuration or secrets. The web container runs the traced standalone
Next server, without development dependencies.

The worker requires only `PIZZA_WORKER_ORIGIN` (the public web origin) and the
matching `PIZZA_WORKER_SECRET`. Its independent schedule is every five minutes,
Railway's minimum. Each run calls authenticated `POST /api/slack/pizza/drain`,
exits, and exits nonzero on failure. Monitor failed cron runs. The worker image
needs only Node's built-in fetch; it needs no Slack credentials, database access
or npm packages. Next.js `after()` usually processes events immediately; the
independent drain recovers accepted work after restarts/deployments and retries
outages. Enable recognition only once the schedule works. Concurrent invocations
are safe.

For a minimal CLI upload, upload this directory to the linked web service. Set
the worker's Dockerfile path and cron settings before uploading the same source
to the worker. Alternatively connect both services to your own GitHub
fork. Keep secrets in Railway variables; production credentials and database
snapshots never belong in Git.

## Delivery, retention and recovery

Ingestion verifies exact raw Slack signatures and persists an eligible event
before ACK. Connection/statement deadlines keep persistence inside Slack's
three-second budget; database failure returns retryable 503. Modals open promptly
with one bounded intent statement and a deadline before `views.open`. Submissions
and commands enter a durable inbox. Transactional awarding/spending/stock/refunds
use one checked-out pg connection, deterministic account locks and unique keys.
Slack calls never hold SQL locks. Inbox/outbox leases expire after 60 seconds;
workers reclaim them after process loss. No in-memory queue is authoritative.

A Slack 429 honours Retry-After; transient outages retry with bounded backoff.
A post timeout can mean Slack accepted the notification. Such deliveries remain
explicitly `ambiguous`; `/pizza admin` shows these and pending request buttons so
an admin can fulfil/cancel even if the original notification is uncertain.
Accounting remains idempotent. Slack notifications can duplicate after an
interrupted delivery; never re-submit a redemption to recover a message.

Operators can inspect:

```sql
SELECT id, notification_key, external_ref, safe_error
FROM pizza_outbox WHERE status='ambiguous';
```

For a reward notification check Slack for the stable request ID; for a
`celebration:` notification check the report type and period/date in `#pizza`.
Private `preview:` notifications are admin replies, not fulfilment requests.
If the message exists, record its Slack reference and set status `sent`; if absent, set `status='pending', retry_at=now()`
to retry. Never alter ledger rows. Response URLs are secret capabilities; only
supported Slack response hosts/paths are used, redirects are rejected, and they
are removed after delivery/expiry. Expired private command replies can be obtained
by invoking `/pizza` again. Worker maintenance purges terminal inbox payloads and
recognition reasons after 30 days. Terminal celebration and private-preview
outbox payloads are also redacted after 30 days, retaining receipt, notification
key and delivery status. Pending/running reports keep their content until delivery
resolution. Duplicate keys, allocations and the append-only ledger remain for
the scheme's lifetime. Logs use only safe error codes.

## Activation smoke check

- Verify all Slack endpoints, `/pizza help`, balance, all leaderboard periods and
  both modes, tier presets, tracking/clearing a goal,
  and private admin previews. Enable celebrations with a launch timestamp only
  after these checks pass.
- Send `@Mike @Sarah 🍕🍕`: two each, four consumed, thread reply. Retry the same
  event and confirm no duplicate accounting; test self/bot/guest/over-budget gifts.
- Configure a test reward as an admin. Open/cancel then redeem; check private
  receipt, admin request, original name/cost, fulfilment and one-time refund.
- Test a non-admin action, stale price, duplicate submission and stock-one race.
- Open settings and save unchanged; open/cancel Adjust balance and inspect history.
  Policy/correction mutation and race checks belong in disposable databases; do
  not change live defaults, balances or prizes just to test the controls.
- Stop/restart the worker with pending work and confirm the independent cron
  drains it. If your workspace has other bots, confirm their existing commands still work.
- Pin the recognition policy in `#pizza`; introduce admin controls in the private
  admin channel. Keep the real catalogue empty until admins choose rewards.

Implementation verification and production activation are separate milestones.
