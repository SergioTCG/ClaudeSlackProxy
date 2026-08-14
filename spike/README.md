# Historical integration spike

These scripts are retained as empirical design evidence, not production entry
points. They use the repository's root dependencies; do not create a second npm
installation or lockfile here.

`slack-spike.mjs` creates and mutates a private test channel in a real workspace.
It requires explicit `SLACK_USER_ID`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN`
environment variables. Never point it at the production app during development.

`server.mjs` is the minimal Claude MCP Channel proof that preceded
`channel/server.mjs`.
