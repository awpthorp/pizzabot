# Reporting a security issue

Please report suspected vulnerabilities privately to `gurus@gr.agency` with
the subject "PizzaBot security report". Include the affected commit/version,
a synthetic reproduction and the impact. Do not send live credentials or
staff records, and do not put exploitable details in a public issue.

Operators should keep Slack tokens, signing secrets, database credentials and
worker secrets outside Git. Rotate any credential that is exposed. Use a
separate database, review workspace/channel/admin settings and keep dependencies
updated. Public source code does not grant access to an installation's data.

Community reports are reviewed without a guaranteed response time. This is
self-hosted software: installation owners are responsible for deployment,
backups, access and updates.
