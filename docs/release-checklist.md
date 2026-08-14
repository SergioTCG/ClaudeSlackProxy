# Release checklist

## Repository and compatibility

- [ ] Release branch starts at the last known-good tag and is clean.
- [ ] Version, changelog, repository URLs, GitHub description, and topics agree.
- [ ] `AGENTS.md`, `CLAUDE.md`, README, architecture, security, and migration
      guide describe the same provider and safety contracts.
- [ ] `slack/app-manifest.json` is the sole Slack manifest.
- [ ] `/cc-*` and `/codex-*` command namespaces are complete and unchanged.
- [ ] Legacy state, config, checkout, control-channel, and LaunchAgent identities
      are covered by tests.
- [ ] No secrets, local state, logs, or generated files are tracked.

## Automated validation

- [ ] `npm ci`
- [ ] `npm run audit` reports zero known production vulnerabilities.
- [ ] `npm test`
- [ ] `npm run check`
- [ ] JavaScript syntax checks pass.
- [ ] Shellcheck passes at warning severity.
- [ ] Installer help and provider selection pass on a clean shell.
- [ ] CI passes on the release commit.

## Installation matrix

- [ ] Upgrade an existing Claude-only installation.
- [ ] Upgrade an existing Claude plus Codex installation.
- [ ] Fresh Claude-only installation.
- [ ] Fresh Codex-only installation.
- [ ] Fresh dual-provider installation.
- [ ] Re-running each installer is idempotent.
- [ ] `install-codex.sh` does not reload or rewrite the live LaunchAgent.
- [ ] No scenario creates a second daemon, control channel, or hook entry.

## Controlled live canary

- [ ] Back up `~/.config/ccs` locally with restrictive permissions.
- [ ] Record the previous release tag and rollback commands.
- [ ] Confirm no active turn is in progress before restart.
- [ ] Exactly one daemon connects with the production Socket Mode token.
- [ ] Existing and fresh Claude sessions send and receive Slack messages.
- [ ] Existing and fresh Codex sessions send and receive Slack messages.
- [ ] Claude and Codex terminal-close → Slack-prompt → Ghostty-resume works.
- [ ] Topics include folder, branch, model, and reasoning effort.
- [ ] File transfer, interrupt, model, effort, flags, and update commands work.
- [ ] Permission relay is exercised once in a non-dangerous test session.
- [ ] No duplicate Slack channels appear.

## Publish

- [ ] Rename the GitHub repository only after old-remote migration is ready.
- [ ] Set the GitHub description and topics.
- [ ] Push the release branch and wait for CI.
- [ ] Publish `v1.0.0-rc.1` as a prerelease.
- [ ] Dogfood the RC before promoting the exact tested commit to `v1.0.0`.
- [ ] Keep `v0.2.28` and the local backup until final acceptance.
