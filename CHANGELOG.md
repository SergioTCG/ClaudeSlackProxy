# Changelog

Notable changes to this project. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning per
[Semantic Versioning](https://semver.org/).

## [1.4.0-rc.5] — 2026-08-18

### Fixed
- Codex target readiness now ignores trailing blank terminal rows. Tall Ghostty
  windows can render the complete idle UI near the top with empty space below;
  that ready state no longer waits until the transactional startup timeout.

[1.4.0-rc.5]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.4.0-rc.5

## [1.4.0-rc.4] — 2026-08-18

### Fixed
- Provisional provider targets now wait for the actual visible agent input
  surface instead of treating tmux creation as application readiness. This
  prevents private validation prompts from being pasted into startup or trust
  screens and silently lost.
- Local folder/hook trust remains explicit: the bridge reports the wait in
  Slack, sends no keys, and continues automatically after the operator approves
  the prompt in Ghostty.
- After validation input is submitted, the provisional provider must register
  a native hook session claim within 30 seconds. Missing hooks now produce a
  fast, visible rollback instead of an ambiguous five-minute wait.

[1.4.0-rc.4]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.4.0-rc.4

## [1.4.0-rc.3] — 2026-08-18

### Fixed
- Large instruction consolidations now ask the auxiliary provider for bounded
  document sections instead of a full unified diff. The bridge constructs and
  validates the Git patch deterministically, avoiding duplicated source text
  and long model-authored deletion hunks.
- Reconciliation runs in a private neutral directory so the repository's
  `CLAUDE.md` is not loaded a second time. Slack and bridge credentials are
  removed from the auxiliary process environment.
- The proposal ceiling defaults to ten minutes and can be bounded through
  `CCS_INSTRUCTION_TIMEOUT_SECONDS`; Slack receives a progress notice every
  minute and a visible safe failure if generation still cannot complete.
- Long proposals now attach the complete patch for owner review instead of
  labelling a truncated preview as the full proposal.

[1.4.0-rc.3]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.4.0-rc.3

## [1.4.0-rc.2] — 2026-08-17

### Fixed
- Provider-switch confirmation buttons now use unique Slack Block Kit action
  identifiers, preventing `invalid_blocks` from silently discarding the
  preflight confirmation.
- A failed switch-preview delivery immediately rolls back its persisted
  preflight instead of blocking retries until the 30-minute expiry.
- Slash-command failures now post a durable channel notice, with the command's
  ephemeral response URL as a bounded fallback when channel posting fails.

[1.4.0-rc.2]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.4.0-rc.2

## [1.4.0-rc.1] — 2026-08-17

### Added
- **Transactional provider handoff.** `/cc-switch` hands an active Claude Code
  channel to Codex, and `/codex-switch` hands an active Codex channel to Claude
  Code. Each Slack channel preserves separate native provider conversations and
  keeps exactly one leg active.
- **Private structured handoffs.** The source produces a bounded SAB v1 summary;
  the target must complete a read-only readiness turn before the channel mapping
  commits. Handoff files are integrity checked, mode `0600`, and retained for
  two generations.
- **Reviewed instruction alignment.** Repository-root `AGENTS.md` and
  `CLAUDE.md` can be reconciled through a constrained unified-diff proposal.
  Hash, path, binary, symlink, mode, apply, and 32 KiB budget checks run before
  an owner-approved patch is left as uncommitted work.

### Safety
- Transition phases are synchronously journaled with atomic state writes. A
  daemon restart or target failure reaps the exact provisional tmux and restores
  the source mapping.
- Owner messages queue at channel scope during a switch and receive target-bound
  artifact grants only after commit. Collaborators cannot enqueue work during a
  transition, and source-session upload grants are revoked on commit.
- Stale and manually started standby hooks cannot create a second channel or
  race the active provider. Cleanup removes every native leg in an archived
  channel lineage.

### Compatibility
- Legacy sessions remain lazy, migration-free Claude records until their first
  switch. Existing configuration paths, channels, launchers, state mappings,
  HTTP port, and LaunchAgent identity remain unchanged.
- Apply the canonical Slack manifest to the same app once to register
  `/cc-switch` and `/codex-switch`; no new scopes, tokens, or second app are
  required.

[1.4.0-rc.1]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.4.0-rc.1

## [1.3.0] — 2026-08-15

### Released
- Promoted the exact RC.1 runtime after a production Slack request generated and
  returned `ana-dashboard-2026-08-15.pdf` (`application/pdf`, 355,972 bytes) in
  the existing `cc-project99-ana` channel through the grant-bound upload path.
- Confirmed the live rollout preserved existing sessions and tmux processes with
  exactly one Socket Mode daemon, while the installed bot reused its existing
  `files:write` grant without a manifest or OAuth change.

[1.3.0]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.3.0

## [1.3.0-rc.1] — 2026-08-15

### Added
- **Generated artifact delivery.** Authorized owner and per-channel collaborator
  prompts can ask Claude Code or Codex to return generated files through the new
  provider-neutral `sab-upload` helper and Slack's current `filesUploadV2` flow.
- Upload capabilities are opaque, one-use, two-hour grants bound to the Slack
  sender/message, provider, live process/tmux session, immutable channel, and
  canonical workspace. The daemon rejects replay, concurrency, traversal,
  symlink escape, non-regular files, more than ten files, or more than 100 MiB.

### Compatibility
- The existing Slack app already has `files:write`; no manifest update,
  reauthorization, token, command, event, configuration, state, channel, hook,
  provider launcher, or LaunchAgent migration is required. Rerunning the local
  installer adds `sab-upload` to `PATH`.

[1.3.0-rc.1]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.3.0-rc.1

## [1.2.0] — 2026-08-14

### Released
- Promoted RC.2 after production canaries confirmed live Codex token progress,
  `/codex-usage` reporting, and quiet topic synchronization against the existing
  Slack app and session.
- Audited all 22 managed channels after an unchanged daemon restart and found
  zero topic-change events. A live Codex turn displayed elapsed time plus total,
  output, and reasoning-token deltas.
- Confirmed the installer recovered from the observed transient launchd error 5
  on its bounded retry while keeping exactly one Socket Mode daemon connected.

[1.2.0]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.2.0

## [1.2.0-rc.2] — 2026-08-14

### Fixed
- The installer retries the transient macOS launchd bootout/bootstrap race up
  to three times with a bounded delay. The RC.1 production canary encountered
  error 5 once and recovered on the next bootstrap attempt.

[1.2.0-rc.2]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.2.0-rc.2

## [1.2.0-rc.1] — 2026-08-14

### Added
- **Codex usage reporting.** `/codex-usage`, `/codex-usage days [n]`, and
  `/codex-usage models` use `ccusage`'s provider adapter for session, project,
  daily, model, token, and cost reports.
- **Live Codex token status.** The edit-in-place working message now combines
  hook-derived elapsed time with bounded `ccusage` snapshots, showing per-turn
  total, output, and reasoning-token deltas as they become available.

### Fixed
- Topic synchronization reads the existing Slack topic after daemon startup and
  calls `conversations.setTopic` only when the desired value differs. Concurrent
  startup updates are serialized per channel, preventing restart-wide topic
  notifications.
- Claude usage queries now select `ccusage claude` explicitly, preventing newer
  unified `ccusage` output from mixing Codex totals into `/cc-usage`.

### Compatibility
- Existing Slack apps must apply `slack/app-manifest.json` to the same app once
  to register `/codex-usage`. No OAuth scopes, tokens, channels, configuration,
  state, hooks, launchers, or LaunchAgent identities change.

[1.2.0-rc.1]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.2.0-rc.1

## [1.1.0] — 2026-08-14

### Released
- Promoted the RC.1 runtime after the production canary preserved the existing
  Codex session and Slack channel across the daemon roll. Post-roll Slack input
  reached the live session with exactly one Socket Mode daemon connected.
- Verified `sab-cc`, `sab-codex`, `ccs`, and `ccs-codex` against the installed
  Claude Code and Codex CLIs before promotion.

[1.1.0]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.1.0

## [1.1.0-rc.1] — 2026-08-14

### Added
- **Provider-neutral launcher names.** `sab-cc` launches Claude Code and
  `sab-codex` launches Codex. Daemon-created and resumed sessions use these
  canonical binaries directly.

### Compatibility
- `ccs` and `ccs-codex` are silent, argument-preserving aliases and remain
  supported throughout 1.x. `CCS_*`, `~/.config/ccs`, internal tmux names,
  Slack commands, hooks, state, tokens, and the LaunchAgent are unchanged.
- Existing installations need only rerun the provider installer once to add the
  `sab-*` symlinks to `PATH`; no Slack app or manifest update is required.

[1.1.0-rc.1]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.1.0-rc.1

## [1.0.0] — 2026-08-14

### Released
- Renamed the project to **Slack Agent Bridge**, with Claude Code and Codex as
  first-class providers under their separate `/cc-*` and `/codex-*` commands.
- Added provider-selective installation, canonical agent/contributor guidance,
  migration and release runbooks, a single Slack manifest, expanded security
  documentation, compatibility tests, and Node 20/24 CI.
- Preserved existing commands, `CCS_*` configuration, state, install paths,
  control channels, and the historical LaunchAgent identity. Existing Slack
  apps need no new tokens, scopes, or replacement manifest for this release.
- Updated the production dependency tree to zero known audit vulnerabilities.
- Promoted the RC.2 runtime after a live Codex kill → Slack wake → Ghostty/tmux
  resume canary preserved its channel, dangerous-mode flag, model, and `xhigh`
  reasoning effort with exactly one daemon connected.

[1.0.0]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.0.0

## [1.0.0-rc.2] — 2026-08-14

### Fixed
- Dead-session permission prompts are pruned at boot and whenever a process is
  ended or restarted. Live Claude prompts remain restart-recoverable, while
  Codex's process-bound held responses still expire safely on daemon restart.

[1.0.0-rc.2]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.0.0-rc.2

## [1.0.0-rc.1] — 2026-08-14

### Added
- **Provider-neutral project identity.** ClaudeSlackProxy is now Slack Agent
  Bridge, with Claude Code and Codex presented as first-class provider adapters.
- **Provider-selective installation.** Fresh setups may install Claude, Codex,
  or both; the old flagless installer remains Claude-only.
- **A documented compatibility contract.** `AGENTS.md`, the migration guide,
  and automated checks protect existing commands, paths, state, channels, and
  the live LaunchAgent across the rename.

### Changed
- The canonical Slack app manifest now lives at `slack/app-manifest.json` and
  carries provider-neutral metadata. The stale Claude-only YAML manifest was
  removed so there is one source of truth.
- Fresh installations and control channels use neutral names. Existing
  `~/.claudeslackproxy` checkouts and `#claude-code-bridge` channels are reused.
- The documented Node.js minimum is now 20, matching the Slack SDK runtime
  requirement instead of the former, inaccurate Node 18 declaration.

### Compatibility
- `/cc-*`, `/codex-*`, `ccs*`, `CCS_*`, `~/.config/ccs`, stored sessions, and
  `si.sergej.claudeslackproxy` remain unchanged. No new Slack app, token, or
  OAuth scope is required.

### Security
- Updated the MCP SDK, usage tooling, and transitive dependencies; the release
  dependency tree audits with no known vulnerabilities.
- The historical Slack spike now requires an explicit test user instead of
  selecting a workspace member, and it no longer carries a second npm lockfile.

[1.0.0-rc.1]: https://github.com/SergioTCG/SlackAgentBridge/releases/tag/v1.0.0-rc.1

## [0.2.28] — 2026-08-14

### Fixed
- **Slack-triggered Codex resurrection no longer waits for local typing.** An
  idle `codex resume` can defer `SessionStart`, while the bridge previously
  waited for that hook before pasting the queued wake message. The first Slack
  message is now supplied as Codex's optional resume prompt, which starts the
  turn immediately; subsequent queued messages retain the existing hook-driven
  flush order.

[0.2.28]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.28

## [0.2.27] — 2026-08-14

### Changed
- **Codex now mirrors Claude's remote-spawn default.** Flagless `/codex-new`
  sessions and resumes without captured launch flags use Codex's canonical
  `--dangerously-bypass-approvals-and-sandbox`. The documented `--yolo` alias
  is accepted in Slack commands and normalized to the canonical flag. Explicit
  flags and `CCS_CODEX_NEW_FLAGS` / `CCS_CODEX_RESUME_FLAGS` still override the
  default.
- **Clarified browser capability.** Codex `--search` enables live web search; it
  is not a counterpart to Claude's `--chrome`. Browser automation still needs
  a separately configured MCP server or plugin.

[0.2.27]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.27

## [0.2.26] — 2026-08-14

### Added
- **Opt-in Codex CLI terminal sessions.** `ccs-codex` and
  `/codex-new <folder>` reuse the existing private-channel, tmux,
  Ghostty, attachment, resurrection, and Slack command infrastructure. Codex
  lifecycle hooks mirror terminal prompts and stable final assistant text;
  synchronous permission hooks relay approve/deny decisions through Slack.
- **Provider-aware commands and state.** Missing provider fields continue to
  mean Claude, so existing state needs no migration. Status/health, model,
  reasoning effort, flags, update, interrupt, spawn API, and project picker now
  dispatch to the active provider.
- **Explicit Slack command namespaces.** `/cc-*` is Claude-only and the parallel
  `/codex-*` commands are Codex-only. Bridge-wide ownership, health, and cleanup
  remain singular under `/cc-*`; Claude usage and account switching remain
  Claude-only. Existing Slack apps must apply the updated manifest once to
  register the new command names; scopes and tokens are unchanged.
- **Separate Codex activation.** `install-codex.sh` idempotently merges user
  hooks and links the launcher without changing Claude settings or restarting
  the daemon. Codex `/hooks` trust remains explicit.

### Fixed
- **Codex channel topics now include reasoning effort.** Codex lifecycle hooks
  expose the model but not effort, so the bridge resolves effort from the
  session's launch override and layered Codex configuration. Existing live
  channels are hydrated safely on daemon restart; Codex transcript JSONL
  remains outside the runtime integration.

### Security
- Codex remote-spawn flags use a narrow provider-specific allowlist; arbitrary
  config overrides, feature toggles, profiles, extra writable directories, and
  hook-trust bypass are rejected.
- Stale hooks from a process being replaced can no longer roll back persisted
  flags/account/model settings or mark the new process dormant.

[0.2.26]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.26

## [0.2.25] — 2026-08-13

### Fixed
- **Window titles stopped mirroring the channel topic.** Ghostty's `title`
  config *pins* a window's title and ignores the escape sequences tmux uses, so
  passing `--title` at spawn silently disabled topic mirroring (windows showed
  the working directory instead). The spawner no longer sets a title at all —
  tmux owns it, and `updateTopic` keeps it in sync with Slack.
- **A windowless bridge instance silently swallowed every window request.** In
  single-icon mode, File → New Window on an instance with zero windows
  "succeeds" (AppleScript even returns the menu item) while opening nothing, so
  sessions stayed windowless with no error. Such instances are now detected and
  reaped, and the caller relaunches an instance instead.

### Known limitation
- **Single-icon mode (`CCS_GHOSTTY_SINGLE=1`) no longer works reliably.**
  Creating a window in a *running* Ghostty needs UI scripting (macOS has no
  Ghostty IPC — `+new-window` is Linux-only), and current Ghostty ignores both
  the File → New Window menu click and ⌘N even with the app frontmost, the menu
  item enabled, and Accessibility granted. It can open the first window (via
  instance launch) and nothing after, so a machine restart degrades it to one
  instance per session. Prefer `CCS_GHOSTTY_HIDDEN=1` (accessory windows, no
  Dock icons at all) or the default one-icon-per-session.

[0.2.25]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.25

## [0.2.24] — 2026-08-13

### Added
- **`/cc-flags` — change a session's launch flags without losing it.** Shows the
  current flags with no argument; `/cc-flags --dsp --chrome` sets them, restarts
  the session and resumes the same conversation (Claude Code reads these at
  startup, so a restart is unavoidable — it's the same dance as `/cc-account`).
  Validated against the existing allowlist, deduped, and persisted so resumes
  keep them. Requires reinstalling the app manifest.
- **`/cc-new` no longer spawns flagless sessions.** With no flags given it used
  to launch a bare `claude` — no `--dangerously-skip-permissions`, so the session
  prompted for every tool and had no way to be corrected from Slack. It now
  applies a configurable default (`CCS_NEW_FLAGS`, default
  `--dangerously-skip-permissions`); explicit flags still replace it entirely.
  The project picker uses the same default.

[0.2.24]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.24

## [0.2.23] — 2026-08-13

### Added
- **Long-context models are selectable.** `Opus 5` and `Opus 5 (1M context)` are
  distinct model ids (`claude-opus-5` vs `claude-opus-5[1m]`), and Claude Code's
  family alias always resolves to the standard one — so the 1M variant was
  unreachable from Slack, and invisible in `/cc-model`'s listing because the
  enumerator's pattern stopped at word characters. Bracketed ids are now
  discovered and listed, and **a bare family alias selects the long-context
  variant when the build has one** (`/cc-model opus` → `claude-opus-5[1m]`),
  since bridged sessions run long. Pass a full id for the standard window. The
  rule is general: any family that gains a `[1m]` sibling picks it up.

### Fixed
- **Windows restored after a reboot became plain shells while their sessions ran
  headless.** macOS reopens the bridge's Ghostty windows with an empty spool, so
  the dispatcher fell through to a login shell and every session looked dead in
  Slack. It now **adopts a live bridged session that has no window** instead.
- **Window requests reported success even when no window appeared.** The scripted
  File → New Window click can silently do nothing (UI scripting), leaving
  sessions windowless with no error anywhere. The daemon now verifies the
  terminal actually attached and falls back to a dedicated window otherwise.

[0.2.23]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.23

## [0.2.22] — 2026-08-11

### Added
- **Per-session Claude subscriptions.** A session can run under a named Claude
  account, so collaborative work bills to whoever owns that session instead of
  everyone sharing one subscription. Manage accounts on the Mac with
  **`ccs-account`** (`add` mints a token via `claude setup-token` in a throwaway
  config dir, so the sign-in never disturbs the machine's own login; `set` takes
  a token minted elsewhere; `list` masks them). Bind and switch from Slack with
  **`/cc-account [name | default]`** — switching restarts the session and
  resumes the same conversation. `/cc-new` and the spawn API accept
  `--account <name>` / `{account}`, and a session's binding survives resume.
  Requires reinstalling the app manifest to register the new slash command.

  **Secrets never travel where they could leak**: tokens live only in
  `~/.config/ccs/accounts` (0600) and are resolved inside `ccs` at launch — the
  command line carries just the account *name*, since `ps` shows every
  process's argv to every user on the machine. Names are strictly validated
  (`[A-Za-z0-9_-]`) before they reach a shell, and tokens never enter
  `state.json`, the daemon log, channel topics, or window titles.

### Fixed
- **A stray hook could hijack a live session and orphan its channel.** The
  identity-refresh path (which legitimately rebrands a record when `/clear`
  gives the same process a new session id) matched purely on the resolved pid,
  so *any* hook whose ppid happened to resolve to a running session's claude
  took that session's record and channel with it. The channel then had no owner,
  the session went silent, and the next hook minted a **duplicate channel** for
  a terminal that already had one. Takeover now requires the payload's own
  transcript to belong to the new session id **and** the same terminal;
  mismatches are logged and ignored.
- **Lost bindings reclaim their channel instead of creating a duplicate.** The
  daemon remembers which terminal owns each channel, so a session whose binding
  disappeared (state edited underneath it, a botched migration, a manual repair)
  re-attaches to its existing channel and posts "Reconnected" rather than
  starting a fresh one.

[0.2.22]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.22

## [0.2.21] — 2026-08-10

### Fixed
- **Plan-approval dialogs reach Slack.** Claude Code's "ready to execute —
  proceed?" dialog renders *after* the turn's Stop hook, when the live-status
  poller has already shut down — so it was never relayed and the session looked
  disconnected. The daemon now runs a one-shot form check shortly after every
  finalize, re-adopts sessions that are waiting at a question form on restart,
  and relays the **plan file itself** (the dialog names it) into the channel
  alongside the buttons. Free-text replies route through "Tell Claude what to
  change" when a plan dialog is open.

[0.2.21]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.21

## [0.2.20] — 2026-08-10

### Fixed
- **Daemon spawns silently produced nothing after Claude Code's updater removed
  its old Homebrew shim.** `ccs` resolved `claude` via PATH; the daemon's PATH
  lacks `~/.local/bin` (the native install's home), so from Aug 8 every
  daemon-launched session died at exec ("claude: not found") within
  milliseconds — no channel, no window, no error. `ccs` now falls back to
  `~/.local/bin` when `claude` isn't on PATH, and the installer's LaunchAgent
  PATH includes it.
- **Detached spawns are now babysat.** The daemon verifies claude reaches its
  prompt before requesting the window (no more mid-boot attach races), captures
  the dying session's last screen into the log when a boot fails (forensics),
  retries once, and — crucially — **fails loudly** through `/spawn`/`ccs-spawn`
  instead of pretending success, so calling scripts can fall back.

[0.2.20]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.20

## [0.2.19] — 2026-08-07

### Added
- **Script-facing spawn API.** `POST /spawn {cwd, flags}` on the daemon's
  localhost port launches a bridged session with flag validation, the
  single-icon window path, and a clean environment — external tooling (e.g.
  worktree scripts) no longer needs its own `open -na Ghostty`, which bypassed
  window grouping and could leak environment. `POST /window {tmux, title}`
  adopts an existing tmux session's viewport under the single icon. New
  `ccs-spawn <dir> [flags...]` CLI wraps `/spawn` and exits non-zero when the
  daemon is unreachable so callers can fall back.

[0.2.19]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.19

## [0.2.18] — 2026-08-04

### Added
- **Single-icon mode (`CCS_GHOSTTY_SINGLE=1`)** — all bridge terminals under
  ONE Ghostty Dock icon, right-click listing every session window by name. A
  dedicated bridge instance runs the new `ccs-window` dispatcher as its
  `command`: every new window pops the next pending session from a spool and
  attaches to its tmux. The daemon creates sessions detached, then requests a
  window — the first via launching the instance, later ones via a scripted
  File → New Window click (requires a one-time Accessibility grant for the
  daemon's `node`; without it, spawns fall back to today's per-instance windows
  and nothing breaks). Windows the user opens manually (Cmd+N) become plain
  shells when nothing is pending.
- **Window titles mirror the channel topic.** Every session window is titled
  exactly like its Slack channel topic — `folder · branch · model · effort` —
  and updates whenever the topic does, so the Dock's window list reads the same
  as your Slack sidebar.

[0.2.18]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.18

## [0.2.17] — 2026-08-04

### Fixed
- **Cross-session message routing corruption.** A session spawned from a shell
  that inherited another session's `CCS_TMUX` (env leaks through `open` /
  Ghostty windows / scripts run inside bridged sessions) registered claiming
  the other session's tmux — so its channel's Slack messages were pasted into
  the wrong terminal, and mirrored back into the wrong channel. Three layers:
  `ccs` now unsets any inherited `CCS_TMUX` (and hardens PATH so the tmux
  self-wrap can't silently degrade in bare login shells); `ghosttySpawn` strips
  all `CCS_*` variables from the environment handed to `open`; and the daemon
  now **validates every tmux claim** — a session's tmux name is only accepted
  if the claiming claude process actually descends from one of that tmux
  session's panes (poisoned stored claims heal to null, falling back to
  channel-plugin injection).
- **Inherited Claude identity no longer produces phantom "child sessions."**
  The same env leak could carry `CLAUDE_CODE_CHILD_SESSION` /
  `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID` into a new `ccs` launch, making the
  new claude believe it was a child of another session — it then wrote **no
  transcript of its own**, silently breaking response mirroring and resume.
  `ccs` now sheds all inherited Claude-identity variables before exec, and the
  daemon's spawner strips `CLAUDE*`/`ANTHROPIC_*`/`CCS_*` from the environment
  it hands `open`.

[0.2.17]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.17

## [0.2.16] — 2026-08-03

### Added
- **Optional dockless terminals.** Each session's window is its own Ghostty
  instance (macOS Ghostty has no IPC to open windows in a running instance), so
  every session normally adds a Dock icon. Set `CCS_GHOSTTY_HIDDEN=1` in
  `~/.config/ccs/env` to spawn them in accessory mode instead: windows stay
  fully visible and clickable but add no Dock icon or Cmd-Tab entry. Default
  remains one Dock icon per session.

### Fixed
- **Launching `ccs` inside an existing tmux session now bridges fully.** The
  self-wrapping branch sets `CCS_TMUX`, but running `ccs` from within tmux
  skipped the wrap and left it empty — the channel got created, yet
  Slack→terminal injection, `/cc-stop`, and the live-status poller silently
  targeted nothing. `ccs` now derives the name from the surrounding tmux
  session (`tmux display-message -p '#S'`) when unset.

[0.2.16]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.16

## [0.2.15] — 2026-08-03

### Fixed
- **Claude Code's internal background workers no longer create ghost channels.**
  Claude Code 2.1.220+ spawns internal helper processes — a transient per-user
  daemon, warm "spare" sessions, and background agents — which inherit
  `CCS_BRIDGE` and the global hooks from their parent session. Their SessionStart
  hooks made the bridge register them as real sessions and create channels
  (e.g. `#code-<stamp>`) out of nowhere. New registrations are now gated on the
  resolved process's command line: anything carrying internal-worker markers
  (`--agent`, `bg-pty-host`, `bg-spare`, `daemon run`, `--session-id`) is
  ignored. Existing bridged sessions are unaffected.

[0.2.15]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.15

## [0.2.14] — 2026-07-28

One release covering two staged changes (0.2.13 was never tagged separately).

### Added
- **Interactive question forms are relayed to Slack.** Claude Code can pause a
  turn on a numbered-options question (sometimes a multi-tab wizard ending in a
  review/Submit screen); previously the bridge showed nothing — the session just
  looked frozen, and replies typed in Slack were eaten by the open form. The
  live-status poller now detects an open form in the terminal, mirrors it to the
  channel as **buttons** (question + options, updating one message in place as
  the wizard advances), and maps answers back to keystrokes. Reply with a bare
  number instead of tapping if you prefer; free-text replies route through the
  form's "Type something" / "Chat about this" option when it offers one. A form
  waiting for input also no longer trips the poller's turn-end fallback.

### Fixed
- **Adopting an existing session no longer risks replaying its entire history
  into Slack.** A session the daemon had never seen (e.g. resuming a pre-bridge
  conversation into a new channel) registered with a transcript offset of 0, so
  the first completed turn would have mirrored the whole historical transcript
  into the channel as one giant dump. Registration now anchors to the
  transcript's current end — only activity from adoption onward is mirrored.
  Brand-new sessions are unaffected (their transcript starts empty).

[0.2.14]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.14

## [0.2.12] — 2026-07-25

### Added
- **`/cc-usage` — token & cost reporting**, powered by
  [ccusage](https://github.com/ryoppippi/ccusage) (bundled as a dependency, no
  separate install). In a session channel it reports that **project**: the
  current session's tokens/cost, the project total across all its sessions, and
  the models used. In the control channel (or any unmapped channel) it reports
  the **aggregate**: the last 7 days day by day, this month, and all time.
  Project scoping works by matching ccusage's per-session rows against the
  `.jsonl` transcripts in the project's `~/.claude/projects/<slug>/` directory.
  Requires reinstalling the app manifest to register the new slash command.
- **`/cc-usage days [n]`** — a per-day sheet (up to 14 days) with models used,
  input/output tokens, cache write/read, total, and cost, plus a Σ row.
  **`/cc-usage models`** — all-time per-model breakdown (in/out/cache w/r/cost).
- **`/cc-usage limits` — your real plan limits, live.** Claude Code's statusline
  feed carries the account rate-limit state, so the daemon now mirrors what
  claude.ai/settings/usage shows: current 5-hour session usage % and reset time,
  weekly all-models % and reset (any additional buckets appear automatically).
  A one-line limits footer also rides on the other usage views when fresh data
  is available. No scraping, no extra auth — it's already in the feed.

[0.2.12]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.12

## [0.2.11] — 2026-07-25

### Added
- **Near-one-click install.** `curl -fsSL …/install.sh | bash` now clones the
  repo itself, opens Slack's app-creation page **pre-filled with the manifest**
  (a shareable `new_app=1&manifest_yaml=` deep link — no copy-pasting JSON),
  validates both pasted tokens live (`auth.test` + `apps.connections.open`, so
  typos fail immediately), and derives the team ID automatically.
- **`/cc-claim` — ownership without hunting for your member ID.** Fresh installs
  start unclaimed; the first person to run `/cc-claim` becomes the owner
  (persisted to `~/.config/ccs/env`, invited to the control channel). Until
  claimed the daemon trusts nobody and does nothing else. `SLACK_USER_ID` no
  longer needs to be looked up by hand.

Install friction drops to: one command, ~4 clicks in Slack, two token pastes,
one `/cc-claim`. A public "Add to Slack" app is deliberately not offered:
Socket Mode delivers an app's events over the app-level token — one shared
stream per app (10-connection cap) — so a shared public app would route every
workspace's events to every user's local daemon. Per-user apps keep each
user's tokens and traffic on their own machine.

[0.2.11]: https://github.com/SergioTCG/ClaudeSlackProxy/releases/tag/v0.2.11

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
