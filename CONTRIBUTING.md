# Contributing to PizzaBot

Thanks for bringing something to the table. Useful bug reports, clearer setup
instructions and focused improvements are welcome.

Start with [self-hosting](docs/self-hosting.md) and [architecture](docs/architecture.md).
For a change, fork the repository, create a branch and open a pull request with
the problem, proposed behaviour and validation. Run `npm run verify` and
`npm run build`. For accounting changes, run the existing integration suite with
`PIZZA_TEST_DATABASE_URL` pointed at a disposable localhost PostgreSQL database.
Do not run tests against an actual team's database.

Preserve these boundaries: one configured workspace/channel, signed Slack
requests, explicit admin authorization, private personal/admin responses,
separate giving/earned/spendable totals, immutable accounting, and recovery
without repeating a completed operation. Add a new migration for a schema
change; do not edit already-applied migration files.

Public issues should use synthetic examples. Never attach tokens, response
URLs, database credentials, workspace exports, private messages or screenshots
containing staff data. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

There is no guaranteed support or release schedule. The MIT license applies
to contributions; dependency licenses remain with their respective owners.
