# Security

## Read this before installing

Slack Agent Bridge is **remote code execution by design**. It connects a Slack
workspace to Claude Code, Codex, and/or Pi processes running with the local
user's filesystem, network, developer credentials, and shell access.

Flagless Slack spawns default to:

- Claude Code: `--dangerously-skip-permissions`
- Codex CLI: `--dangerously-bypass-approvals-and-sandbox` (`--yolo`)
- Pi: unrestricted built-in tools (no extra dangerous-mode flag is needed)

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
  answer permissions, or resurrect the session. Their accepted prompts may ask
  the live agent to return generated workspace artifacts to that same channel.
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
  `$HOME`. Claude, Codex, and Pi use separate remote-flag allowlists.
- **Provider isolation:** `/cc-*` can affect only Claude sessions,
  `/codex-*` only Codex sessions, and `/pi-*` only Pi sessions. Cross-provider
  flags are rejected.
- **Transactional provider switch:** only the owner can confirm a switch. The
  source remains authoritative until a target-native readiness turn succeeds;
  target failure or daemon restart restores the source. Exact tmux/provider
  claims fence stale and standby hooks from racing the active leg.
- **Private, bounded handoffs:** provider handoffs exclude chain-of-thought,
  credentials, tokens, complete transcripts, and large source dumps. They are
  capped at 64 KiB, integrity checked, stored under `~/.config/ccs/handoffs`
  with restrictive modes, and retained for two generations.
- **Reviewed instruction changes:** automatic preflight reads only root
  `AGENTS.md` and `CLAUDE.md`, never global provider memory. The auxiliary
  provider runs in a private neutral directory without Slack or bridge
  credentials and returns bounded document sections; it does not author patch
  syntax. The bridge creates the patch deterministically. Proposed patches are
  read-only until owner approval and are constrained by hashes, Git-root paths,
  regular-file/symlink checks, binary/rename/mode rules, temporary apply
  validation, `git apply --check`, and the Codex instruction-size budget.
- **Capability-bound file egress:** an accepted Slack prompt creates an opaque,
  one-use upload grant lasting at most two hours. It is bound to that sender,
  message, provider, live process/tmux session, channel, and canonical workspace.
  The agent cannot select another Slack destination. Realpath checks reject
  traversal and symlink escapes; only regular files are accepted, with ten-file
  and 100 MiB aggregate limits. Successful grants cannot be replayed, and all
  outstanding grants disappear when the daemon restarts. A committed provider
  switch also revokes grants issued to the source leg; queued owner messages
  receive new target-bound grants after commit.
- **Explicit Codex hook trust:** setup never bypasses Codex's hash-based hook
  review. Changed hooks require local review through `/hooks`.
- **Failure-safe permission relay:** if Codex cannot obtain a Slack verdict, the
  hook returns no decision and Codex falls back to its local approval policy.
- **Explicit Pi extension loading:** the bridge extension is loaded by
  `sab-pi` from the checked-out release and is not installed globally or into a
  project. Its inbound stream and permission endpoints require matching Pi
  process, tmux, session, provider, and active/provisional lineage claims.
- **Fail-closed Pi safe mode:** SAB `--safe` blocks a Pi tool call unless the
  owner approves it. Relay loss, timeout, malformed responses, and identity
  failures deny the call. This safety mode is distinct from Pi `--approve`,
  which trusts project-local settings, extensions, skills, and packages and may
  itself authorize code running with the macOS user's privileges.
- **Isolated adaptive routing:** ordinary owner prompts default to a no-tools,
  low-thinking child that receives only visible prompt text. Upload grants,
  attachment bytes, bridge/tmux identity, extensions, session state, skills,
  themes, project approval, and bridge/Slack/other-agent environment are
  withheld. Pi provider credentials may still be required to invoke the
  selected model.
  Classifier failure or ambiguity promotes to managed execution; collaborators
  never trigger it. `/pi-run mode native` disables classification for the
  session and `/pi-run direct` bypasses it once.
- **Bounded managed Pi runs:** automatic promotion and `/pi-run` are owner-only;
  managed runs carry explicit
  wall-clock, parent-turn, subagent, and review-cycle limits. Planner, scout,
  and reviewer children receive only read/search tools. Child processes have
  bridge/tmux/upload identity and Slack/other-agent environment removed. They
  load no session, extensions, skills, prompt templates, themes, or project
  approvals. Worker children are disabled
  under `--safe`, because their writes cannot traverse the parent's interactive
  Slack approval gate.
- **Local secrets:** Slack tokens and account credentials stay under
  `~/.config/ccs` with restrictive permissions and are ignored by Git.
- **Conservative self-update:** the updater fast-forwards only a clean checkout
  with no unpublished local commits. Set `CCS_AUTO_UPDATE=0` to require manual
  review and deployment.

These measures reduce accidental exposure; they do not sandbox a provider that
was deliberately launched in dangerous mode.

Managed-run budgets are circuit breakers, not a security boundary. In
unrestricted mode the parent—and an explicitly selected worker child—still has
the macOS user's filesystem, process, network, and credential access. A long
goal can consume substantial local inference time. Pause or cancel it from
Slack when its scope or progress is no longer appropriate.

## Safer operating choices

- Protect Slack and provider accounts with strong unique credentials and MFA.
- Restrict Slack app installation and private-channel access.
- Use a dedicated macOS account or host for the bridge when practical.
- Keep provider credentials scoped to the repositories and services required.
- Supply explicit safer approval/sandbox flags instead of the dangerous default
  when unattended execution is unnecessary.
- Override remote defaults through `CCS_NEW_FLAGS`, `CCS_RESUME_FLAGS`,
  `CCS_CODEX_NEW_FLAGS`, `CCS_CODEX_RESUME_FLAGS`, `CCS_PI_NEW_FLAGS`, and
  `CCS_PI_RESUME_FLAGS`. Use SAB `--safe` when Pi tool calls should require
  Slack approval.
- Review changes to launchers, hooks, the Slack manifest, and dependencies before
  enabling self-update on a security-sensitive host.
- Regularly inspect private-channel membership and collaborator allowlists.
- Remember that mirrored prompts, responses, filenames, and attachments are
  stored under the Slack workspace's retention and administration policies.
- Treat artifact requests as deliberate data egress. Review collaborator access
  before asking an agent to send generated files containing proprietary data.

## Tokens and local files

`~/.config/ccs/env` contains the bot token (`xoxb`) and Socket Mode app token
(`xapp`). `~/.config/ccs/accounts` may contain Claude bearer credentials. Treat
both as password stores: never paste them into issues, logs, shell history, or
agent prompts, and never commit configuration backups.

The app-level token can open the Socket Mode event stream; the bot token can act
with the OAuth scopes declared in `slack/app-manifest.json`. Compromise of either
requires immediate rotation. State maps local sessions, processes, paths, and
Slack channel IDs and should also remain private. During a provider transition,
it temporarily journals queued owner prompts and minimal Slack-file metadata so
a daemon restart can return them to the restored or committed leg.

## Research-preview dependencies

Claude support uses the Channels research-preview API through
`--dangerously-load-development-channels`. Anthropic may change or remove that
contract, including its consent or permission behavior. Pin and test Claude Code
before an unattended production upgrade when stability matters.

Codex support uses lifecycle and permission hooks. The bridge consumes stable
hook payload fields and deliberately avoids transcript JSONL, but hook behavior
can still evolve. Re-review hook changes after Codex upgrades.

Pi support uses its native extension API. The bridge deliberately avoids Pi
session JSONL, but the extension surface and trust semantics may evolve. The
release extension-loading and controlled Slack canaries are mandatory after a
Pi upgrade.

## Incident response

If the bridge may be compromised:

1. Stop the local service:

   ```bash
   launchctl bootout "gui/$(id -u)/si.sergej.claudeslackproxy"
   ```

2. Revoke the Slack app-level and bot tokens in Slack immediately.
3. Revoke or rotate affected Claude, Codex, Pi/provider, Git, cloud, and local credentials.
4. Inspect Slack channel history, daemon logs, provider transcripts, Git changes,
   running processes, and shell history from a trusted environment.
5. Reinstall from a verified release before issuing replacement tokens.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow in the Security tab instead
of opening a public issue. This is a personal open-source project maintained on
a best-effort basis with no formal response SLA.
