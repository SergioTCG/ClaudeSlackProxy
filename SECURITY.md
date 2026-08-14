# Security

## Read this before installing

ClaudeSlackProxy is **remote code execution by design**. It bridges a Slack
workspace to Claude Code or opt-in Codex sessions running on your machine.
Slack-spawned Claude sessions use `--dangerously-skip-permissions` by default;
Slack-spawned Codex sessions use
`--dangerously-bypass-approvals-and-sandbox` (`--yolo`) by default. Explicit
launch flags replace those defaults. In plain terms:

> **Anyone who can post a message as you in your Slack workspace can run
> arbitrary commands on your computer, with your filesystem and credentials.**

This is the intended feature, not a bug. But it means the trust boundary is
your Slack account and workspace, so treat it accordingly.

## What the bridge does to reduce risk

- **Single trusted sender.** The daemon only acts on messages from the one
  Slack user ID you configure (`SLACK_USER_ID`). Everyone else is ignored.
- **Private channels only.** Session channels are created private; other
  workspace members can't see or post in them.
- **Outbound-only networking.** The daemon uses Slack Socket Mode — an outbound
  WebSocket. It opens no inbound ports on your machine.
- **Restricted spawning.** `/cc-new` and `/codex-new` only launch sessions in
  directories under `$HOME` and accept separate provider-specific CLI flag
  allowlists. The namespace selects the provider; provider flags are rejected.
- **Explicit Codex hook trust.** Codex setup does not bypass hash-based hook
  review. You must trust the relay in `/hooks`; changed hooks require review
  again. If Slack approval cannot be reached, Codex falls back to its local
  prompt rather than treating the operation as approved.
- **Secrets stay local.** Tokens live in a local env file that is never
  committed (see `.gitignore`).

## What you are responsible for

- **Protect your Slack account** (strong password + 2FA). It is now a remote
  shell into your machine.
- **Trust your workspace.** Don't run this in a workspace where you don't trust
  the admins — a workspace admin can impersonate users or read private channels.
- **Keep the token file private.** The bot and app tokens grant control of the
  bridge; if either leaks, revoke and reinstall the Slack app immediately.
- **Understand `--dangerously-skip-permissions`.** Sessions won't prompt before
  running commands or editing files. Use permission relay (approve/deny from
  Slack) for sessions where you want a human in the loop.
- **Choose Codex flags deliberately.** The Slack-spawn default,
  `--dangerously-bypass-approvals-and-sandbox`, removes Codex's local safeguards
  and makes the Slack-account trust boundary especially important. Supply a
  safer explicit policy when you want Codex's sandbox or Slack approval relay.

## Dependency on a research-preview feature

The bridge is built on Claude Code's **Channels** research-preview API and runs
custom channels via `--dangerously-load-development-channels`. This flag and the
underlying contract can change or be removed by Anthropic at any time, which may
break the bridge or its security assumptions. Pin your Claude Code version if
you need stability.

Codex support uses its documented lifecycle hooks. Hooks are a newer product
surface and may evolve; review hook changes and Codex release notes before
upgrading a security-sensitive unattended installation.

## Reporting a vulnerability

Please report security issues privately via GitHub's **Report a vulnerability**
button (the repository's Security tab) rather than opening a public issue. This
is a personal open-source project maintained on a best-effort basis; there is no
formal SLA.
