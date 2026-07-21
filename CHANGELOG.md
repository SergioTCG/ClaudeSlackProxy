# Changelog

Notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning per
[Semantic Versioning](https://semver.org/).

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
