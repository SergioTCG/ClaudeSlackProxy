# Migrating to 1.4

Version 1.4 adds transactional provider handoff inside an existing private Slack
session channel. It does not merge Claude Code and Codex conversations. Instead,
one logical channel owns two provider-native legs and activates exactly one at a
time.

## Slack app update

Apply [`slack/app-manifest.json`](../slack/app-manifest.json) to the **existing
Slack app** once. This registers `/cc-switch` and `/codex-switch`.

Do not create a second Slack app, Socket Mode token, daemon, or manifest. No OAuth
scope or event subscription changes are required, so the current tokens remain
valid. Existing channels and the control channel are reused.

## State compatibility

No bulk state migration runs. A legacy session without `provider` remains
Claude, and a channel receives a `lineages` record only when its first provider
switch is previewed. During normal operation `state.channels[channel]` continues
to identify the active session, so 1.3 rollback remains possible before a
channel has switched.

After a successful switch, the active native session keeps `session.channel`;
the preserved standby session has no channel binding until it becomes active
again. Both provider-native session IDs, models, effort levels, launch flags,
and Claude account selection remain independent.

## Private handoffs

Handoffs and reviewed instruction proposals live under
`~/.config/ccs/handoffs` with `0700` directories and `0600` files. The bridge
retains the latest two handoffs per channel. State stores only metadata, hashes,
and paths—not the handoff body.

Owner prompts arriving during a transition are temporarily journaled in the
private state file until delivery. Attachment queue entries retain only the
minimal Slack download metadata needed to recover them.

The handoff is a bounded Markdown summary, not a transcript or hidden-reasoning
export. It explicitly excludes credentials, tokens, chain-of-thought, complete
conversation history, and large source dumps.

Target startup is also transactional. The bridge waits for the visible provider
input surface before pasting private validation, reports a local folder/hook
trust gate without answering it, and requires the provider's lifecycle hooks to
claim the native session before commit. Until then the Slack topic continues to
show the source provider deliberately. Startup, trust, hook, or validation
failure discards the exact provisional tmux and restores the source leg.

## Repository instructions

Before switching, the bridge inspects only root `AGENTS.md` and `CLAUDE.md` in
the session's Git worktree. It does not read or consolidate global Claude/Codex
memory, `MEMORY.md`, or files outside the repository.

The preferred shape is a canonical, compact `AGENTS.md` plus a thin `CLAUDE.md`
that points to it and contains only Claude-specific additions. An owner may:

- review and apply the bridge's constrained unified-diff proposal;
- switch without applying it; or
- cancel.

The auxiliary provider runs from a private neutral directory with Slack and
bridge credentials removed. It returns bounded `AGENTS.md` and Claude-specific
document sections rather than diff syntax; the bridge constructs the thin
wrapper and Git patch deterministically. Long-running generation posts a Slack
progress update every minute and defaults to a ten-minute ceiling. Set
`CCS_INSTRUCTION_TIMEOUT_SECONDS` in `~/.config/ccs/env` to a bounded 60–1800
second value when a repository needs a different ceiling.

Proposals may touch only those two root files. The complete patch is attached
for review when it exceeds the inline preview. Hash checks, regular-file and
symlink checks, binary/rename/mode restrictions, a temporary apply validation,
`git apply --check`, and the 32 KiB Codex instruction budget all run before an
actual apply. Applied changes remain uncommitted for ordinary project review.

## Controlled rollout

Follow [`release-checklist.md`](release-checklist.md). In particular:

1. Back up `~/.config/ccs` with restrictive permissions and record the 1.3 tag.
2. Apply the canonical manifest to the current Slack app.
3. Roll exactly one daemon during an idle maintenance window.
4. Verify existing Claude and Codex message/resume paths before switching.
5. Canary Claude → Codex, then Codex → the original Claude native leg.
6. Force one target-start failure and confirm automatic source rollback.
7. Restart during a test transition and confirm recovery leaves one active leg.

Do not promote the release candidate until both round-trip and rollback canaries
pass with exactly one Socket Mode daemon and no duplicate channels.

## Rollback

Stop the daemon, restore the pre-upgrade `~/.config/ccs` backup, return the
checkout to the recorded 1.3 tag, refresh dependencies if required, and start
the historical LaunchAgent label. The Slack app may keep the two extra commands;
an older daemon will simply not service them. Never run 1.3 and 1.4 daemons
simultaneously against the same app token.
