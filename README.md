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
balance are distinct; redemption spends available points without changing earned
leaderboard scores. Unused giving allowance expires at midnight; no reset job.

Every unique direct mention receives the total pizza count in message text:
`@Mike @Sarah 🍕🍕` gives two each and costs four. Duplicate mentions count once.
Unicode 🍕 and Slack `:pizza:` both count. Code, quotes, group mentions,
attachments, forwarded messages and reactions do not count. Original thread
replies count; edits/deletions never change accepted ledger entries. Self gifts,
invalid recipients and insufficient allowance reject the whole award privately.
Bots, deleted users, guests and external members are ineligible. An optional
participant allowlist can restrict eligible regular members to staff.

Commands: `/pizza` or `balance`, `help`, `leaderboard [month|all]`, `rewards`,
and admin-only `admin`. The month leaderboard uses the Dubai calendar month and
earned points, with Slack IDs breaking ties. `/pizza admin` shows reward controls,
pending requests, and ambiguous notifications. `/pizza admin rewards [page]`,
`requests [page]`, and `deliveries [page]` show additional records; pages start at 0.

The initial reward catalogue is empty. Admins add/edit/archive rewards via modals,
including positive integer cost, fulfilment description and optional stock.
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
The managed runner applies only `db/migrations/2026-10-08_pizza_recognition.sql`
in this repository, under an advisory lock with immutable checksums. Repeated
apply executes no migration SQL. Never edit a migration after production apply.
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

Check Slack for the stable request ID. If the message exists, record its Slack
reference and set status `sent`; if absent, set `status='pending', retry_at=now()`
to retry. Never alter ledger rows. Response URLs are secret capabilities; only
supported Slack response hosts/paths are used, redirects are rejected, and they
are removed after delivery/expiry. Expired private command replies can be obtained
by invoking `/pizza` again. Worker maintenance purges terminal inbox payloads and
recognition reasons after 30 days. Duplicate keys, allocations and the append-only
ledger remain for the scheme's lifetime. Logs use only safe error codes.

## Activation smoke check

- Verify all Slack endpoints, `/pizza help`, balance and both leaderboard periods.
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
