# Grassroots PizzaBot

A private Slack recognition app for Grassroots Creative Agency. Staff give 🍕 in
one public recognition channel, view private balances/leaderboards, and redeem
company rewards that configured admins fulfil manually. This is a standalone
Next.js API service with its own Postgres database. Grassroots Assistant and the
clients dashboard stay on their existing services. There is no dashboard UI or
AI model dependency.

## Recognition policy

Five pizzas to give per original message's Asia/Dubai calendar day, including
weekends. Receiving does not replenish giving. Lifetime earned and available
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

`/pizza admin` shows reward controls, pending requests, and ambiguous notifications.
`/pizza admin rewards [page]`, `requests [page]`, and `deliveries [page]` show
additional records; pages start at 0. `/pizza admin preview [week|month]` privately
shows the current period to a configured eligible admin, even before celebrations
are enabled. A preview creates no public report or scheduling receipt.

The initial reward catalogue is empty. Admins add/edit/archive rewards via modals,
including positive integer slice cost, fulfilment description and optional stock.
Add Small, Medium and Large open editable presets of 6, 8 and 12 slices; Custom
keeps existing rewards valid. The tier is a label: changing it never silently
changes the entered price. Georgia chooses the actual names, prizes and stock.
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
request. Price changes require renewed confirmation. Alex and Georgia receive
admin controls; admins fulfil or cancel/refund pending requests. A fulfilled
request cannot be cancelled. Request names/prices retain their original snapshot.

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

Use the separate PizzaBot app `A0C8JMFUETA` in workspace `T01G975PL7M`.
`slack/pizza-manifest.json` uses
`https://pizzabot-production-a20f.up.railway.app` for events, `/pizza`, and
interactivity. Change all three URLs if the origin changes. The Events URL can
verify with only `PIZZA_SIGNING_SECRET` configured while the feature is disabled.
Normal mutations fail closed until all configuration is valid.

Install the app and explicitly invite it into public `#pizza` and private
`#pizza-rewards-admin`. Scopes are `channels:history`, `channels:read`,
`groups:read` (for private admin channel), `chat:write`, `users:read`, `commands`.
No automatic channel joins, email access, reactions, public distribution or
Marketplace submission. Subscribe to `message.channels` and `user_change`.
Upload `assets/pizzabot-icon.png` as the app icon (flat pizza slice generated with
the built-in ImageGen tool). Do not change Assistant's app or Make.com URLs.

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
to the worker. Alternatively connect both services to the same private GitHub
repository. Keep secrets in Railway variables; production credentials and database
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
- Stop/restart the worker with pending work and confirm the independent cron
  drains it. Confirm `/brain` and an existing Assistant button still work.
- Pin the recognition policy in `#pizza`; introduce admin controls in the private
  admin channel. Keep the real catalogue empty until admins choose rewards.

Implementation verification and production activation are separate milestones.
