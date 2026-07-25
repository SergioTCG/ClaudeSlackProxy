# Changelog

Notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning per
[Semantic Versioning](https://semver.org/).

## [0.2.10] — 2026-07-25

### Added
- **Auto-update.** The daemon checks GitHub at startup and every 6 hours; when a
  new release lands it fast-forwards its git clone, runs `npm ci --omit=dev` if
  `package.json` changed, and restarts itself via launchd — sessions keep
  running and are re-adopted, and the control channel gets a "Bridge updated
  vX → vY" note. Safety guards: never touches a checkout with local changes or
  local commits (dev machines), only fast-forwards, waits for running turns to
  finish (up to 10 min) before restarting, and skips silently when offline.
  Opt out with `CCS_AUTO_UPDATE=0` in `~/.config/ccs/env`.

[0.2.10]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.10

## [0.2.9] — 2026-07-25

### Fixed
- **Resurrects and `/cc-new` can no longer wedge silently when Ghostty is in a
  bad state.** Correcting 0.2.8's diagnosis: Ghostty 1.3.1 runs one process per
  window (not single-instance); an instance whose window failed to initialize
  lingers windowless, and enough of those make every subsequent window fail —
  the bridge then re-posted "Waking…" forever while nothing appeared, until
  Ghostty was quit manually. Three defenses, now safe because closing a window
  no longer kills sessions via tmux hooks: spawned instances self-quit when
  their window closes (`--quit-after-last-window-closed=true` is back); a
  reaper kills windowless instances, but only ones **older than 60s**, making
  0.2.8's fatal init-race (reaping a spawn still materializing) impossible; and
  every spawn is now **verified** — if the terminal doesn't materialize, the
  daemon kills the failed attempt, reaps, retries once, and otherwise reports
  the wedge honestly instead of spamming "Waking…".
- **Messages during a wake no longer stack extra terminals.** A resurrect in
  flight now blocks duplicate spawns (and duplicate "Waking…" posts) until the
  session is actually up; queued messages flush as before.

[0.2.9]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.9

## [0.2.8] — 2026-07-24

One batch release for today's run of features and fixes (staged internally as
0.2.5–0.2.8; only `v0.2.8` is tagged).

### Added
- **`/cc-update`** — update Claude Code and restart the current session with its
  original launch flags, resuming the same conversation. It stops the session,
  runs `claude update`, then relaunches through the resume path — so a session
  picks up a new CLI build (and newly released models) without losing context.
  Needs the app manifest reinstalled to register the new slash command.
- **`/cc-model` lists available models with real versions.** With no argument it
  now shows each alias, its display name, and its full model id (e.g. `opus` →
  Opus 5 → `claude-opus-5`), enumerated from the installed `claude` binary so the
  list stays correct across updates — nothing hardcoded.

### Fixed
- **`/cc-effort` and `/cc-model` now answer Claude Code's confirmation prompt.**
  Changing effort or model invalidates the prompt cache, so Claude Code asks
  "Change effort level? Yes / No" — which the daemon left hanging. The first
  `/cc-effort max` therefore did nothing (the channel topic stayed `low`), and only
  a second call — whose stray Enter confirmed the first dialog — took effect. The
  daemon now detects the dialog and confirms the highlighted "Yes," so a single
  call applies.
- **Effort is preserved across a resume.** `/effort` is per-session in Claude Code
  and resets to the default (low) on `--resume`. The daemon now remembers a
  session's effort (from the statusline / `/cc-effort`) and re-applies it as an
  `--effort` launch flag when resuming, so a restarted session keeps its effort.
- **A session whose working directory drifted into a subfolder can resume again.**
  `--resume` is scoped to the launch dir's project slug, but the daemon's recorded
  cwd follows the statusline — so if claude `cd`'d into a subdirectory mid-session,
  resuming looked for the transcript under the wrong slug, found nothing, and the
  session died instantly on every wake (`Waking up…` → `Session ended`). The daemon
  now re-anchors a resume to the directory that actually holds the transcript.
- **Resurrecting or spawning a session no longer kills every other session — and
  closing a terminal still ends its session.** Ghostty 1.3.1 runs single-instance
  on macOS: opening any window (every resurrect / `/cc-new` / `/cc-update`) briefly
  detaches every *other* window's tmux client for a fraction of a second before it
  re-attaches. The 0.2.1 `client-detached → kill-session` hook fired on that
  instantaneous blip — killing a session, whose window then closed and blipped the
  rest — a chain reaction that wiped out all live sessions on any spawn. The tmux
  hook is gone; instead the daemon watches client attachment and ends a session
  only after its window has stayed gone for a grace period (8s), well past any
  transient blip. So genuinely closing a terminal still terminates the session
  (write to resume), while a spawn leaves every other window untouched. Also
  reverted the 0.2.3 `--quit-after-last-window-closed` flag and the Ghostty process
  reaper, which assumed the old multi-instance model. The daemon strips the old
  hook from already-running sessions on boot.
- **A finished turn's response can no longer be silently lost.** Response
  mirroring relied solely on the Stop hook; if that hook was missed — across a
  daemon restart mid-turn, or on a very long auto-compacted turn — the final
  response landed in the terminal but never in Slack. The live-status poller now
  detects turn-end (the spinner disappearing) and finalizes as a fallback,
  mirroring the response and clearing status. It is idempotent with the Stop hook
  (the read offset guards against a double post).
- **A stranded transcript read-offset now self-heals on restart.** The offset is
  persisted with a debounced write that a hard restart (`kickstart -k` sends
  SIGKILL) could drop, leaving mirroring stuck behind and silently mirroring
  nothing. On boot, idle live sessions re-anchor their offset to the transcript's
  end; sessions mid-turn keep their offset and resume the poller (which will
  finalize them via the fallback above).

[0.2.8]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.8

## [0.2.4] — 2026-07-24

### Added
- **Collaborators — invite teammates into a session.** A per-channel whitelist
  lets you allow specific Slack users to send prompts to the session behind that
  channel. Manage it from `/cc-status` in a session channel: a user-picker adds a
  collaborator, a Remove button revokes them, and the current list is shown. A
  collaborator's prompt is injected labelled `[Slack collaborator <name>]`, so
  the transcript records who said what. Collaborators can send prompts only — not
  permission verdicts, `/cc-*` commands, or session resurrection — and only into a
  live session; all owner-only actions stay owner-only. The whitelist persists
  across daemon restarts. No Slack app changes required (uses the existing
  `users:read` scope and interactive components).

### Fixed
- **Live status survives a daemon restart.** The status poller and each status
  message's reference lived only in memory, so restarting the daemon mid-turn
  froze that turn's Slack status — it could no longer be updated, nor cleared
  when the turn ended. On boot the daemon now re-adopts any session still showing
  a spinner (resuming the poller on the existing status message, in place) and
  clears stale status for turns that ended while it was down.

[0.2.4]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.4

## [0.2.3] — 2026-07-23

### Fixed
- **`/cc-new` (and resume) could fail with Ghostty's "terminal failed to
  initialize."** Each session opens its own Ghostty instance via
  `open -na Ghostty.app`. With Ghostty's default `quit-after-last-window-closed=false`,
  a terminated session left a *windowless* instance running, and enough of these
  eventually starved a fresh spawn of a GPU surface — the new window failed to
  initialize (and, having no surface, showed a neighboring window's title).
  Spawned instances now quit when their window closes
  (`--quit-after-last-window-closed=true`), and the daemon reaps any
  dead-session Ghostty instances before each spawn.

[0.2.3]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.3

## [0.2.2] — 2026-07-22

### Fixed
- **Resume a session whose folder was deleted** (e.g. a removed git worktree)
  instead of failing silently. Claude Code scopes `--resume` to the folder's
  project and the spawn did `cd <folder>` first, so a missing folder made the
  window close instantly with the message lost. The transcript survives in
  `~/.claude/projects`, so the daemon now recreates the folder empty at its
  original path and resumes there (with a warning). The conversation is
  preserved; files from the deleted folder are not.

[0.2.2]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.2

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
