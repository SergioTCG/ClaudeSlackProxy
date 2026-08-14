# Security

## Read this before installing

Slack Agent Bridge is **remote code execution by design**. It connects a Slack
workspace to Claude Code and/or Codex processes running with the local user's
filesystem, network, developer credentials, and shell access.

Flagless Slack spawns default to:

- Claude Code: `--dangerously-skip-permissions`
- Codex CLI: `--dangerously-bypass-approvals-and-sandbox` (`--yolo`)

Explicit launch flags replace those defaults. In plain terms:

> Anyone able to send an accepted Slack message as the bridge owner can cause
> arbitrary commands to run on this Mac with the owner's local privileges.

This is the intended feature. The primary security boundaries are therefore the
Slack account, Slack workspace administration, local token files, provider
accounts, and the Mac user running the daemon.

## Trust model

- One Slack user claims the bridge and becomes its owner. Slash commands,
  permission decisions, session resurrection, and configuration remain
  owner-only.
- Session channels are private. The owner may explicitly allow collaborators to
  send labelled prompts to a live session; collaborators cannot run commands,
  answer permissions, or resurrect the session.
- Workspace administrators may have powers that bypass ordinary private-channel
  expectations or impersonate/recover accounts. Do not use an untrusted
  workspace.
- The local Mac user can read provider credentials and bridge state and is fully
  trusted. This project is not a multi-user host isolation boundary.

## Risk-reduction measures

- **Sender allowlist:** messages from users other than the owner or an explicitly
  allowed live-session collaborator are ignored.
- **Private channels:** session and control channels are created private and are
  mapped by immutable Slack channel ID.
- **Outbound Slack connection:** Socket Mode uses an outbound WebSocket and
  requires no internet-facing listener. The local hook/channel HTTP service
  binds to loopback on port `8877`; it must not be exposed through a proxy.
- **Restricted spawning:** Slack-created working directories must resolve under
  `$HOME`. Claude and Codex use separate remote-flag allowlists.
- **Provider isolation:** `/cc-*` can affect only Claude sessions and
  `/codex-*` only Codex sessions. Cross-provider flags are rejected.
- **Explicit Codex hook trust:** setup never bypasses Codex's hash-based hook
  review. Changed hooks require local review through `/hooks`.
- **Failure-safe permission relay:** if Codex cannot obtain a Slack verdict, the
  hook returns no decision and Codex falls back to its local approval policy.
- **Local secrets:** Slack tokens and account credentials stay under
  `~/.config/ccs` with restrictive permissions and are ignored by Git.
- **Conservative self-update:** the updater fast-forwards only a clean checkout
  with no unpublished local commits. Set `CCS_AUTO_UPDATE=0` to require manual
  review and deployment.

These measures reduce accidental exposure; they do not sandbox a provider that
was deliberately launched in dangerous mode.

## Safer operating choices

- Protect Slack and provider accounts with strong unique credentials and MFA.
- Restrict Slack app installation and private-channel access.
- Use a dedicated macOS account or host for the bridge when practical.
- Keep provider credentials scoped to the repositories and services required.
- Supply explicit safer approval/sandbox flags instead of the dangerous default
  when unattended execution is unnecessary.
- Override remote defaults through `CCS_NEW_FLAGS`, `CCS_RESUME_FLAGS`,
  `CCS_CODEX_NEW_FLAGS`, and `CCS_CODEX_RESUME_FLAGS`.
- Review changes to launchers, hooks, the Slack manifest, and dependencies before
  enabling self-update on a security-sensitive host.
- Regularly inspect private-channel membership and collaborator allowlists.
- Remember that mirrored prompts, responses, filenames, and attachments are
  stored under the Slack workspace's retention and administration policies.

## Tokens and local files

`~/.config/ccs/env` contains the bot token (`xoxb`) and Socket Mode app token
(`xapp`). `~/.config/ccs/accounts` may contain Claude bearer credentials. Treat
both as password stores: never paste them into issues, logs, shell history, or
agent prompts, and never commit configuration backups.

The app-level token can open the Socket Mode event stream; the bot token can act
with the OAuth scopes declared in `slack/app-manifest.json`. Compromise of either
requires immediate rotation. State maps local sessions, processes, paths, and
Slack channel IDs and should also remain private.

## Research-preview dependencies

Claude support uses the Channels research-preview API through
`--dangerously-load-development-channels`. Anthropic may change or remove that
contract, including its consent or permission behavior. Pin and test Claude Code
before an unattended production upgrade when stability matters.

Codex support uses lifecycle and permission hooks. The bridge consumes stable
hook payload fields and deliberately avoids transcript JSONL, but hook behavior
can still evolve. Re-review hook changes after Codex upgrades.

## Incident response

If the bridge may be compromised:

1. Stop the local service:

   ```bash
   launchctl bootout "gui/$(id -u)/si.sergej.claudeslackproxy"
   ```

2. Revoke the Slack app-level and bot tokens in Slack immediately.
3. Revoke or rotate affected Claude, Codex, Git, cloud, and local credentials.
4. Inspect Slack channel history, daemon logs, provider transcripts, Git changes,
   running processes, and shell history from a trusted environment.
5. Reinstall from a verified release before issuing replacement tokens.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow in the Security tab instead
of opening a public issue. This is a personal open-source project maintained on
a best-effort basis with no formal response SLA.
