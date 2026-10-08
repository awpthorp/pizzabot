# Put PizzaBot in your own Slack workspace

PizzaBot is free, MIT-licensed source code. Each team runs its own backend,
database and Slack app. There is no shared Grassroots installation, hosted free
plan or one-click public OAuth service. Budget separately for infrastructure,
prizes and someone to maintain your installation.

## What you need

- A Slack workspace where you can create/install an app, subject to your
  workspace's approval policy.
- Node.js 22 and a dedicated PostgreSQL database.
- A public HTTPS address for the Next.js API service.
- A scheduler that calls the authenticated drain endpoint every five minutes.
- At least one regular workspace member to administer rewards.

The supplied Dockerfiles support a web service and a small scheduled worker.
Grassroots runs those plus managed Postgres on Railway. Another host with the
same capabilities can work. You do not need Grassroots' dashboard, its Assistant
or any AI API key. This version uses Asia/Dubai for allowance resets and reports;
changing the timezone/report times requires a code change and corresponding
period tests. The timezone is not an admin menu setting.

## 1. Get the code and deploy an initially disabled backend

Fork the repository, then clone your fork and install dependencies:

```sh
git clone https://github.com/YOUR_ACCOUNT/pizzabot.git
cd pizzabot
npm ci
cp .env.example .env.local
```

For local development, `npm run dev` uses port 3003. Slack needs a public HTTPS
URL to reach your local instance, or a deployed web service. Configure secrets
in the host's environment; never commit `.env.local`.

Keep `PIZZA_ENABLED=false` and `PIZZA_CELEBRATIONS_ENABLED=false` during setup.
Create a dedicated database and set `DATABASE_URL` on the web service. Deploy
with the root `Dockerfile`, pre-deploy command `npm run migrate` and health check
`/api/health`. See the [README deployment table](../README.md#railway-web-and-worker)
for the exact web/worker settings. The migration runner applies each migration
once; do not modify already-applied SQL files.

## 2. Create your own Slack app

Use [Slack's app manifest workflow](https://docs.slack.dev/app-manifests/) with
`slack/pizza-manifest.json`. Replace **every** `https://pizzabot.example.com`
placeholder with your backend's HTTPS origin: the `/pizza` command, events and
interactivity URLs must all point to your service.

Copy your app's Signing Secret to the web service's `PIZZA_SIGNING_SECRET`.
The events endpoint can answer Slack's signed URL verification challenge while
giving is disabled. Install the app through your workspace's normal approval
process, then set its bot token in `PIZZA_BOT_TOKEN`.

The manifest requests `channels:history`, `channels:read`, `groups:read`,
`chat:write`, `users:read` and `commands`, with `message.channels` and
`user_change` events. Recognition is restricted to one configured public,
internal channel. Private admin channel information is used to validate reward
delivery. There is no email access or automatic channel joining.

Use your own app/workspace IDs in `PIZZA_APP_ID` and `PIZZA_TEAM_ID`. You can get
the app ID from Slack's app settings and the workspace ID from its Slack URL
or the bot's authenticated `auth.test` response. Upload `assets/pizzabot-icon.png`
as the app icon if you would like to use the included pizza slice.

## 3. Create channels and configure admins

Create a public recognition channel such as `#pizza` and a private reward
operations channel such as `#pizza-rewards-admin`. Invite the bot to both.
Channel names are for humans; configure the actual channel IDs in:

```text
PIZZA_RECOGNITION_CHANNEL_ID=your public channel ID
PIZZA_ADMIN_CHANNEL_ID=your private admin channel ID
PIZZA_ADMIN_USER_IDS=comma-separated regular-member Slack IDs
```

Use Copy member ID on staff profiles for admin IDs. General Slack admin status
does not automatically confer PizzaBot admin access. Bots, guests, deleted
accounts and external members are excluded. `PIZZA_PARTICIPANT_USER_IDS` is an
optional further allowlist for eligible regular staff; leave it empty to allow
all otherwise eligible regular members in this workspace.

## 4. Set up recovery and report scheduling

Generate a separate random worker bearer secret of at least 32 characters.
Do not reuse the Slack signing secret. Set `PIZZA_WORKER_SECRET` on both services.

Build the worker from `Dockerfile.worker`, with schedule `*/5 * * * *` and restart
policy NEVER. Set only `PIZZA_WORKER_ORIGIN` (your web HTTPS origin) and
`PIZZA_WORKER_SECRET` on the worker. It does not need Slack credentials or the
database URL. A run calls `POST /api/slack/pizza/drain`, exits, and reports failures
through its exit status. Monitor failed runs.

The web service usually processes accepted work immediately. The independent
worker recovers queued work after interruptions and checks when reports are due.
Run `npm run worker` with the worker environment configured to verify the drain.

## 5. Launch and make it yours

Run `npm run verify` and `npm run build` before deploying changes. Real database
integration tests need an explicitly disposable local database; see the README.
Then set `PIZZA_ENABLED=true` once credentials, workspace/channel IDs, admins and
the independent worker are ready. In the public channel, give one real thank-you
to an eligible teammate, and check `/pizza balance` and `/pizza leaderboard`.

Use `/pizza admin` to add your own prize catalogue. The initial catalogue is
empty. `/pizza admin settings` changes the daily giving allowance, Small/Medium/
Large slice presets and the separate weekly/monthly report switches. Defaults
are five pizzas to give per Dubai day and presets of 6, 8 and 12 slices. These
presets do not mean a real pizza or automatically create a reward.

If you want automatic reports, set `PIZZA_CELEBRATIONS_ENABLED=true` and set
`PIZZA_CELEBRATIONS_START_AT` to your actual launch instant as an ISO timestamp
with timezone. Reports due before that instant are not posted. Keep that launch
timestamp stable on future deployments. Weekly reports are due Friday after
16:00 Dubai; monthly reports are due after 10:00 Dubai on the first. The next
drain delivers them, rather than guaranteeing an exact posting minute.

Pin a short user guide in your channel. Include the important counting rule:
`@Mike @Sarah 🍕🍕` gives **two each**, costing four from the giver's allowance.
An invalid or over-budget award is rejected as a whole. Normal commands remain
private; `/pizza leaderboard share` intentionally posts standings publicly when
invoked in the configured recognition channel.

## Keep your installation healthy

You own your workspace credentials, database, backups and operational decisions.
Keep secrets in server-side environment settings, back up data before schema
changes and review dependency updates. Recognition records include Slack IDs
and thank-you text, so choose access and retention policies for your team.
The current maintenance job removes terminal inbox payloads and recognition
reasons after 30 days, while retaining ledger/accounting records.

Read [Technical architecture](architecture.md) for delivery, locking and
retention details and the README's recovery procedure for ambiguous Slack
deliveries. Check a stable operation ID before retrying an uncertain message;
never repeat an award or redemption just to repair its notification.
