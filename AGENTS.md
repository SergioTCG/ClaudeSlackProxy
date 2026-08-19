# Agent and contributor guide

This file is the canonical set of repository instructions for humans and coding
agents. Provider-specific instruction files may add constraints, but they must
not copy or contradict this contract.

## Product contract

Slack Agent Bridge connects one trusted Slack owner to local interactive coding
agent sessions. Claude Code, Codex, and Pi are separate provider adapters over
shared Slack, state, tmux, Ghostty, and lifecycle infrastructure.

These public interfaces are compatibility-sensitive:

- `/cc-*` always selects Claude Code; `/codex-*` always selects Codex; `/pi-*`
  always selects Pi.
- Missing `session.provider` means Claude. Never bulk-migrate old state merely
  to make provider fields explicit.
- `sab-cc`, `sab-codex`, and `sab-pi` are the canonical provider launchers.
  `sab-upload` is the shared artifact-return helper. `ccs` and `ccs-codex` remain
  compatibility aliases throughout 1.x.
- `ccs-account`, `ccs-spawn`, internal `ccs-*` tmux names, and `CCS_*` remain
  stable until a separately designed migration justifies changing them.
- Configuration and state remain in `~/.config/ccs`; the local HTTP port remains
  `8877` unless an explicit migration is designed and documented.
- The historical LaunchAgent label `si.sergej.claudeslackproxy` remains the one
  service identity. Do not load a second label during a rename or upgrade.
- Existing `~/.claudeslackproxy` checkouts and `#claude-code-bridge` control
  channels are valid. Fresh 1.0 installs may use their neutral replacements.
- The canonical Slack manifest is `slack/app-manifest.json`. There must not be a
  hand-maintained second manifest.

## Live-installation safety

This repository may also be the installation serving a live Slack workspace.
Before changing runtime files, inspect the Git status, current branch, daemon
working directory, and launchd label. Develop in a separate worktree when the
live service points at the primary checkout.

Do not restart, unload, replace, or roll the daemon during ordinary development.
A live rollout requires an explicit maintenance step, a clean release commit,
the complete validation suite, and a known-good rollback tag. Never run two
Socket Mode daemons with the same Slack app token: they race for events.

Never commit `.env`, `state.json`, account files, tokens, logs, transcripts, or
generated MCP configuration. Do not print secrets during diagnostics.

## Architecture invariants

- One daemon owns the sole Slack Socket Mode connection and persisted state.
- Every interactive provider process is wrapped in tmux inside a visible or
  dockless Ghostty window. tmux remains the terminal and lifecycle control
  surface; provider-native channel/extension streams may carry inbound text.
- Slack channels are private and mapped by channel ID, not mutable channel name.
- A switched channel may own separate Claude, Codex, and Pi native legs, with
  exactly one active. Keep `state.channels[channel]` authoritative; only the active
  session has `session.channel`. Create lineage state lazily, never by bulk
  migration.
- Claude inbound messages use its MCP Channel server; hooks mirror lifecycle and
  outbound content. Preserve the channel consent and account-switching paths.
- Codex inbound messages use tmux; lifecycle hooks provide stable outbound final
  text and permission decisions. Never parse Codex transcript JSONL directly;
  usage telemetry may enter only through `ccusage`'s public JSON adapter.
- Pi inbound messages, lifecycle, usage, settings, and optional safe-mode tool
  decisions use the explicitly loaded `pi/sab-extension.ts`. Do not install it
  globally or parse Pi session files. Pi's native project trust remains a
  separate decision from SAB safe-mode tool approval.
- Pi owner prompts use native-session-persistent adaptive routing by default;
  collaborators remain native. The read-only classifier must receive visible
  prompt text only—never artifact grants or attachment bytes—and must fail
  toward managed execution. Explicit `/pi-run` goals remain force-managed;
  `direct` and `native` remain deliberate bypasses.
- Managed Pi runs persist only bounded route/goal/plan/counter state in the
  native session. Child Pi processes must not inherit bridge identity,
  Slack/upload capabilities, extensions, skills, session state, or project
  approval. Keep planning, scouting, and independent review read-only; never
  bypass the parent safe-mode approval gate with a child writer.
- Generated-file delivery is provider-neutral. The daemon, not the agent,
  chooses the Slack destination from a short-lived grant tied to an accepted
  Slack message and its live session.
- A provider namespace is authoritative. Reject a command or flag that belongs
  to the other provider before it can mutate a session.
- Hook handlers must remain quick, bounded, and failure-tolerant. A hook or Slack
  API error must not crash the long-running daemon.
- State writes remain atomic. Replacement processes must not be overwritten or
  marked dormant by stale hooks from the process they superseded.
- Provider-switch phase changes require immediate atomic persistence. Private
  handoff/alignment turns must not mirror into Slack, and a target must not
  receive the channel until its read-only readiness turn validates.

Read `ARCHITECTURE.md` before altering session lifecycle, PID adoption, channel
binding, terminal spawning, permission flow, or self-update behavior.

## Security invariants

The bridge is remote code execution by design. Flagless Slack spawns currently
default to Claude `--dangerously-skip-permissions` and Codex
`--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Pi's built-in tools are
unrestricted by default; SAB `--safe` adds fail-closed Slack tool approval,
while Pi `--approve` controls project resource trust only. Preserve explicit
operator overrides and document any change to these defaults prominently.

Only the owner may run commands, resurrect sessions, or answer permissions.
Collaborators may send labelled prompts only to a live, explicitly allowed
session. Spawned working directories must remain contained under the user's
home directory, and remote launch flags must use provider-specific allowlists.

Artifact uploads must require an owner or per-channel collaborator message,
live process/tmux proof, and a one-use expiring grant. Resolve every file's real
path and keep it inside the workspace captured by that grant; reject missing,
non-regular, escaped, oversized, or replayed uploads. Agents never select a
channel ID or arbitrary destination.

Provider switching is owner-only. Queue owner prompts by channel during the
transaction, reject collaborator prompts, revoke source artifact grants on
commit, and mint new grants only when queued prompts enter the committed leg.
Automatic instruction alignment may inspect only repository-root `AGENTS.md`
and `CLAUDE.md`; never merge global/provider memory or `MEMORY.md`.

## Development workflow

1. Start from a clean branch or isolated worktree and inspect unrelated changes.
2. Add or update a regression test before changing compatibility-sensitive code.
3. Keep provider-specific behavior in `daemon/providers.mjs` or a clearly named
   adapter instead of scattering prefix checks across the daemon.
4. Use one canonical source for repeated command or identity data.
5. Update README, architecture, security, migration, manifest, and changelog when
   their contracts change.
6. Run the complete local validation suite before committing.

Required validation:

```bash
npm ci
npm run audit
npm test
npm run check
for file in daemon/*.mjs channel/*.mjs scripts/*.mjs bin/sab-upload; do node --check "$file"; done
PI_OFFLINE=1 pi --extension ./pi/sab-extension.ts --list-models
shellcheck -S warning bin/sab-cc bin/sab-codex bin/sab-pi \
  bin/ccs bin/ccs-account bin/ccs-consent bin/ccs-codex \
  bin/ccs-spawn bin/ccs-window hooks/hook.sh hooks/codex-hook.sh \
  install.sh install-codex.sh install-pi.sh
```

For a release, also complete `docs/release-checklist.md`. Real Slack, Ghostty,
Claude, Codex, and Pi smoke tests happen only in a controlled maintenance window or
against a completely separate Slack app and tokens.

## Release rules

- Follow Semantic Versioning and Keep a Changelog.
- Release candidates use `vX.Y.Z-rc.N`; never label an untested worktree final.
- Preserve the previous release tag and configuration backup until the new
  daemon has passed Slack create/message/resume tests for all installed providers.
- Repository renames happen only after code, docs, installer migration, and old
  remote detection are ready together.
- Do not rewrite historical changelog entries merely to replace the former
  repository name; GitHub redirects preserve those release links.
