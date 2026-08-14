# Claude Code repository instructions

Read and follow `AGENTS.md`; it is the canonical repository and release
contract. This file adds only Claude-specific constraints.

- Preserve the MCP Channel server and
  `--dangerously-load-development-channels server:slack-bridge` launch path.
- Do not make Codex hook or tmux behavior the implicit model for Claude. Claude
  retains transcript mirroring, status parsing, consent handling, Chrome flags,
  account binding, and `ccusage` support.
- A state record without `provider` is a Claude session and must remain
  resumable without migration.
- Claude remote defaults use `--dangerously-skip-permissions`; `--dsp` is only
  an accepted alias. Explicit flags and the `CCS_NEW_FLAGS` /
  `CCS_RESUME_FLAGS` operator settings override the fallback.
- Changes to Claude hooks, channel startup, consent detection, or transcript
  reading require the existing provider tests plus a local start/resume smoke
  test before release.
