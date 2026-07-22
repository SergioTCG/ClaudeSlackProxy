# Changelog

Notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning per
[Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-07-22

Terminal-lifecycle correctness fixes.

### Fixed
- **Closing a session's window now terminates it.** `ccs` wraps sessions in
  tmux, which used to keep `claude` running headless after the window closed. A
  `client-detached` tmux hook now runs `kill-session` on close, so the session
  genuinely ends — the channel posts "session ended," and writing to it resumes
  in a fresh terminal.
- **Resume preserves launch flags.** A resumed session dropped its original
  flags (`--dangerously-skip-permissions`, `--chrome`, `--model`, …) and ran in
  default permission mode, prompting for every tool. `ccs` now reports its flags
  to the daemon, which replays them on resume. Sessions launched before this fix
  fall back to `--dangerously-skip-permissions` (override via `CCS_RESUME_FLAGS`).

[0.2.1]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.1

## [0.2.0] — 2026-07-22

Native Slack slash commands, real-time status, and a reactive channel topic.

### Added
- **Native `/cc-*` slash commands** with command autocomplete, replacing the
  `./`-prefixed messages: `/cc-model`, `/cc-effort`, `/cc-new`, `/cc-status`,
  `/cc-health`, `/cc-stop`, `/cc-kill`, `/cc-cleanup`, `/cc-help`.
- `/cc-new` posts a project picker (dropdown of `CCS_CODE_DIR`); `/cc-model` and
  `/cc-effort` show the current value with no argument or set it with one.
- `/cc-status` in a session channel shows folder, branch, live git status,
  model, and effort; in the control channel it lists all sessions.
- **Live real-time status**: while a turn runs, the terminal's spinner (verb +
  elapsed + tokens) mirrors into an edit-in-place Slack message and clears when
  the turn ends.
- **Interrupt** a running turn from Slack (`/cc-stop`, via tmux Escape).
- **Reactive channel topic** — `folder · branch · model · effort`, updated as
  the session changes (deduped so Slack is only called on a real change).
- Statusline integration: `hooks/statusline.sh` forwards Claude Code's
  documented status JSON (model, effort, tokens, cost) to the daemon.

### Fixed
- Critical: the daemon crash-looped when a timer posted to an archived channel
  (unhandled rejection). Added global crash guards so no single Slack API error
  can take the daemon down.
- System task-notifications were mirrored as fake "You typed" messages; filtered.
- `loadEnv` merges the config env and repo `.env` so a partial config file no
  longer masks tokens.

### Removed
- The `./`-prefixed commands, superseded by the native `/cc-*` slash commands.
  Typing `./model` (etc.) now returns a one-line hint pointing to `/cc-model`.

[0.2.0]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.0

## [0.1.0] — 2026-07-21

First public release.

### Added
- Channel-per-session bridge between Slack and local Claude Code sessions.
- Bidirectional mirroring: terminal prompts, Claude's responses, live tool
  status, and markdown → Slack with native table blocks.
- Slack → session injection (full text via tmux paste); dormant sessions are
  resurrected in a Ghostty window on the next message.
- Remote session spawning (`./new`) restricted to `$HOME` and an allowlist of
  flags.
- Permission relay — Approve/Deny from Slack (buttons or `yes/no <id>`) for
  sessions not running `--dangerously-skip-permissions`.
- File and image attachments from Slack, downloaded and read by Claude.
- Mid-turn narrative: prose and tool activity appear as the turn unfolds.
- Long responses upload as a `response.md` file; code fences survive the trip
  to Slack.
- Commands: `./status`, `./health`, `./kill`, `./cleanup`, `./model`,
  `./effort`, `./new`, `./help`.
- launchd daemon over Slack Socket Mode (outbound-only); auto-dismissed
  research-preview consent dialogs.
- `install.sh` installer and `~/.config/ccs` configuration.

[0.1.0]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.1.0
