# Contributing

Start with [AGENTS.md](AGENTS.md) for architecture, compatibility, security, and
validation requirements. Small focused changes are preferred, and every change
to a public command, state shape, installer path, or provider launch contract
needs a regression test and matching documentation.

Use a separate Slack app for integration development. Two daemons connected
with the same Socket Mode token will split events unpredictably.
