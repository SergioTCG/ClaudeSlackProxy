# Slack ↔ Claude Code Bridge — Feasibility Study

*Investigated 2026-07-21. Local environment: Claude Code 2.1.216, macOS, Node 24.3.0 (no tmux, no Bun). Slack facts verified against docs.slack.dev; Claude Code facts against code.claude.com/docs.*

## Verdict

**Feasible end-to-end, with no hard blockers — and substantially easier than a terminal-scraping approach, because Claude Code now ships first-party primitives for almost every piece.** The design that emerges is a *message-level* bridge (hooks + Channels API + Slack Web API), not a *terminal-level* one (pty mirroring à la VibeTunnel). That sidesteps the entire resize/relayout class of bugs, which partly live in Claude Code's own TUI and would be inherited by any pty approach.

Two discoveries reshape the original plan:

1. **Claude Code "Channels" (research preview)** is a first-party, documented contract for pushing chat-app messages *into* a running local session. A channel is a local MCP server the session spawns (stdio); it emits `notifications/claude/channel` events that arrive in the live session (visible in the terminal), can expose a `reply` tool, and can **relay permission prompts** for remote approve/deny. Official plugins exist for Telegram, Discord, iMessage — **not Slack**. Building the Slack channel plugin is the core of this project. No tmux keystroke injection needed.
2. **Remote Control now works from any browser** (claude.ai/code), not just the mobile app — `claude --remote-control` makes the terminal session simultaneously steerable from web/phone, and `claude remote-control --spawn worktree --capacity 32` spawns new worktree-isolated sessions on demand. It has **no Slack surface and no channel lifecycle**, so it doesn't replace this project, but it patches the "remote laptop over web" gap *today* and already supports `/model <arg>` and `/effort <arg>` remotely.

## Requirement → mechanism map

| Requirement | Mechanism (verified) | Status |
|---|---|---|
| My terminal prompts visible in Slack | Global `UserPromptSubmit` hook (`~/.claude/settings.json`) → POST to local daemon → `chat.postMessage` | ✅ |
| Claude's responses in Slack | `Stop` hook + read last assistant message from the realtime session JSONL (`~/.claude/projects/<slug>/<session-id>.jsonl`) | ✅ |
| Slack messages reach the live session | Custom **Slack channel plugin** (Channels API); event appears in the terminal, Claude acts in-session; the hook mirror then posts the response back — full loop without a `reply` tool | ✅ |
| Real-time status ("flibbertigibbeting…") | The whimsical spinner verbs are client-side only (not in hooks/statusline/OTel). Equivalent or better: `PreToolUse`/`PostToolUse` hooks → `assistant.threads.setStatus` ("is thinking…", usable in regular channels with just `chat:write` since 2026-03-05) and/or a throttled `chat.update` status line; optional token streaming via `chat.startStream`/`appendStream`/`stopStream` (`markdown_text`, Tier 4 = 100+/min) | ✅ (substitute) |
| Nice formatting incl. tables | Slack has **native Block Kit table blocks** since 2025-08-14 (≤100 rows, ≤20 cols, API-only) + mrkdwn conversion; >4k chars → chunk or file upload (`files.getUploadURLExternal` flow) | ✅ |
| `./model`, `./effort` from Slack | The one open item: channel events are context, not slash commands. Candidates to spike: (a) drive via Remote Control web (supports both with args today), (b) thin tmux layer used *only* for command injection, (c) test whether settings hot-reload (`ConfigChange` hook exists) applies model/effort mid-session | ⚠️ open, 3 candidate paths |
| Channel per session, e.g. `barrique-main-20260721-1721` | `SessionStart` hook (payload: `session_id`, `cwd`, source: `startup\|resume\|clear\|compact\|fork`) → `conversations.create` (name: lowercase/digits/`-_`, ≤80 chars — fits) + invite user. Bot can rename its own channels; you can rename freely in UI (workspace admin); mapping keyed by immutable `channel_id` | ✅ |
| Archive on session end | `SessionEnd` hook (reasons enumerated: `clear`, `resume`, `logout`, `prompt_input_exit`, …) → `conversations.archive` (bot token OK). Crash without `SessionEnd` → daemon PID-liveness sweep archives lazily | ✅ |
| Unarchive on resume | `SessionStart source=resume` (resume keeps the **same** session ID and transcript file — confirmed) → `conversations.unarchive`. **Quirk: bot tokens cannot unarchive (officially documented)** — daemon needs a user token (`xoxp`, one-time OAuth of yourself) for this one call, or the fallback is "park + rename" instead of archive | ✅ with user token |
| Spawn sessions from Slack with flags | Daemon command (e.g. `./new Barrique --dsp --chrome`, or `./issue 66` → Barrique's `start-issue.sh`) → daemon spawns the session (headless `-p --input-format stream-json --output-format stream-json`, later resumable in a real terminal via `claude --resume <id>` — headless↔TUI interop is documented; or spawn into a Terminal window via osascript as `open-worktree.sh` does today) | ✅ |
| Remote access with no port forwarding | **Socket Mode** (outbound WebSocket, explicitly positioned for machines behind NAT; up to 10 concurrent connections per app → one central daemon owns the socket and multiplexes all sessions) | ✅ |

## Architecture shape that falls out (decision deferred, per plan)

- **One launchd daemon** on the Mac Studio: owns the single Socket Mode connection, the session↔channel mapping store, all Slack Web API calls, the liveness sweep, and the spawn command.
- **Per-session Slack channel plugin** (MCP server, Node-compatible — Node 24 is installed; MCP SDK is the only hard dependency): forwards daemon→session injection; registers the session with the daemon.
- **Three global hooks** (`SessionStart`, `UserPromptSubmit`, `Stop`, plus optionally `PreToolUse`/`PostToolUse`/`SessionEnd`): tiny fire-and-forget clients that POST to the daemon and exit — hooks are synchronous, so they must stay <100 ms; the daemon does the slow Slack work async.
- **A launcher wrapper** replacing `vt claude ...` in Barrique's `run-claude-vt.sh`: adds `--channels`/`--dangerously-load-development-channels server:slack` (research-preview flag for custom channels) and any session defaults. Barrique's worktree registry (worktree ↔ branch ↔ issue) provides meaningful channel names for free.

Notably token-efficient: mirroring via hooks costs zero model tokens; only Slack-injected messages consume turns (as any prompt would).

## Slack platform constraints that shape the design

- `chat.postMessage`: ~1 msg/sec/channel; keep `text` ≤4,000 chars (hard truncate at 40k) → chunk long responses or upload files.
- `chat.update`: Tier 3 (~50/min), 4k limit — fine for a single edited-in-place status message.
- ≤50 blocks/message; table block ≤100 rows / ≤10k chars aggregate.
- Streaming APIs work in regular channels but only as **thread replies** (`thread_ts` + `recipient_user_id`/`recipient_team_id` required); minor doc ambiguity on whether the Agent-app config is required → spike test; fallback is the classic throttled `chat.update` loop.
- Avoid `conversations.history` backfill: since 2025-05-29, new non-Marketplace apps get severely limited history reads (~1 req/min reported). Mirror forward-only — which is the design anyway.
- Free plan would suffice (custom app + Socket Mode fine; 90-day history, 10-app cap); paid removes retention limits. Anthropic's official Claude-in-Slack requires a paid plan, but it's cloud-only and irrelevant here.

## Security (this is remote code execution by design)

- Socket Mode = no inbound ports. Private channels by default.
- Gate on **your Slack user ID** (sender allowlist, the same pattern the official Telegram/Discord plugins use via pairing codes); silently drop everyone else.
- Directory allowlist + flag allowlist for the spawn command; optional confirm step.
- Channels' permission relay matters less for you (sessions run `--dangerously-skip-permissions`), but is available for permissioned sessions (`yes <id>` / `no <id>` replies in Slack).
- Note: while Remote Control is connected, transcripts are stored on Anthropic servers; the Slack bridge stores conversation content in Slack. Both are your own accounts, but worth stating.

## Prior art — why build (survey of ~10 projects, July 2026)

Every existing OSS bridge is a **thread-per-session headless bot**; none do channel-per-session, none do archive/unarchive lifecycle, none mirror a local interactive TUI, none spawn with arbitrary CLI flags:

- `mpociot/claude-code-slack-bot` (TS, 177★, single commit June 2025, unmaintained) — SDK-headless, Socket Mode, good message-rendering code to borrow.
- `retrodigio/claude-channel-slack` (TS/Bun, 2★) — **a Slack plugin over the same first-party Channels API**; the closest reference implementation (Socket Mode, permission-relay buttons, thread→subagent routing).
- `nariakiiwatani/claude-slack-bridge` (Py, active 2026) — Socket Mode, thread-per-session, can "fork" an existing local CLI process (headless).
- `yuya-takeyama/cc-slack` (Go, stale), `tomeraitz/claude-slack-bridge` (Py, ask-human-via-Slack only), others — narrower.
- Non-Slack remote control: **Happy** (22.7k★, very active; own app, takeover semantics), **Omnara** (cloud-dependent), **claude-code-webui**, **claude-squad** (tmux+worktrees, local only), **VibeTunnel** (still gets commits but maintenance posture unclear; resize pain partly = Claude Code's own TUI bugs — issues #55762, #49086, #46981 et al.).
- First-party: Claude Code on the web + Claude in Slack / Claude Tag are **cloud-execution only** — cannot touch your machine. Remote Control is the only first-party local-machine surface, and it has no Slack integration. No first-party Slack↔local-CLI bridge exists or is announced.

## Risks / open items

1. **Channels is a research preview**: custom channels require `--dangerously-load-development-channels` at each launch (wrapper hides it; a startup consent dialog appears), the contract may change, and the flag syntax is explicitly unstable. Your account is a personal org where you're admin, so no org gating applies (verified locally).
2. **Unarchive needs a user token** — one-time OAuth against your own workspace; or drop archiving in favor of rename/park.
3. **Slash-command injection** (`./model`, `./effort`) — three candidate paths, none verified yet (see map).
4. **Single-writer rule**: don't run `-p --resume <id>` against a session open in a TUI; daemon must enforce handoff on resume.
5. **Streaming-in-channels ambiguity** (Agent-app config vs plain `chat:write`) — spike test; safe fallback exists.
6. `SessionEnd` won't fire on `kill -9` → liveness sweep required (planned).

## Recommended next step: a 1-day spike before any architecture commitment

1. Minimal Slack channel plugin (adapted from the official fakechat/telegram sources + retrodigio's repo): prove a Slack message arrives in a live interactive session on 2.1.216 under `--dangerously-load-development-channels`.
2. Slack app with Socket Mode: prove create → post → archive with bot token, unarchive with user token.
3. Hooks → daemon → Slack round trip: `UserPromptSubmit` + `Stop` mirroring latency and fidelity (tables via table block).
4. `assistant.threads.setStatus` + `chat.startStream` in a regular channel with `chat:write` only.
5. The three `./model` injection candidates.

After the spike: architecture decisions (daemon language — TS/Bolt vs Go; storage; channel-per-session vs optional thread mode; spawn strategy headless-vs-Terminal-window) with real data.

## Design revision v2 (2026-07-21, after a 15-minute Remote Control field test)

Sergej adopted Remote Control, and within 15 minutes hit its structural limit: reopening an older session from claude.ai/code and prompting it produced *"Remote Control disconnected — Your terminal's Claude Code session stopped responding"* after ~2 minutes (screenshot evidence). Root cause: claude.ai/code is a window into a *running* local process; nothing on the machine can resurrect a dead one. Decision: **build the bridge**, with these amendments:

1. **No archiving, ever.** Dormant channels stay open (daemon may mark them, e.g. a "💤 session ended — write here to resume" note). This deletes the user-token requirement (bot tokens can't unarchive) and the whole unarchive quirk.
2. **Terminal invariant:** every active Claude Code session MUST have a live terminal window on the Mac Studio, in **Ghostty**, regardless of origin:
   - started locally → normal flow, wrapper adds the channel plugin;
   - started from Slack (`./new <dir> [flags]`) → daemon spawns a Ghostty window running `claude <flags>`;
   - message written to a channel whose session has no live process → daemon transparently spawns a Ghostty window running `claude --resume <session-id>` in the stored cwd, rebinds the channel, and delivers the queued message once the session is up.
3. **No headless sessions at all** → the single-writer/handoff concern dissolves.

Ghostty spawn mechanics (verified locally): macOS launch is `open -na Ghostty.app --args --working-directory=<dir> --title=<t> -e <command…>`; `wait-after-command` defaults to false (window closes when the command exits). Programmatic spawn+marker test: see spike results.

Revised spike list and **results (2026-07-21 evening, empirical, on 2.1.216 / Max plan)**:

1. ✅ **Channel injection into a live interactive session: PROVEN.** Spike server (`spike/server.mjs`, ~40 lines: MCP + `claude/channel` capability + HTTP POST→`notifications/claude/channel` on 127.0.0.1:8790). In an interactive session launched with `--mcp-config … --strict-mcp-config --dangerously-load-development-channels server:sptest`, POSTed probes appeared as `← sptest: PROBE-99…` and Claude replied to each, idle-wakeup included. The dev-flag consent dialog + MCP consent require one human keypress per launch (research-preview tax; wrapper minimizes it).
   - Counterpart finding: in headless `-p` mode (stream-json long-lived), events were **silently dropped** (consent dialog can't render). Irrelevant to design v2 (interactive-only), but rules out headless shortcuts.
2. ✅ **Ghostty programmatic spawn: PROVEN** (`open -na Ghostty.app --args -e zsh -lc "<cmd>"` ran a command and wrote a proof marker; window self-closed). **Caveat discovered:** `--working-directory` was ignored in combination with `-e` — the wrapper must `cd <dir> &&` inside the `-lc` command string.
3. ⬜ Resume-with-same-session-id via spawned Ghostty — deferred to build phase (low risk: same-ID resume is documented and transcript-verified).
4. ✅ **Slack side: ALL GREEN** (`spike/slack-spike.mjs`, run 2026-07-21 18:30 against a real multi-person workspace). auth ✓, private-channel create ✓, invite ✓, bot rename ✓, postMessage ✓, edit-in-place chat.update ✓, **native table block ✓**, Socket Mode connect + live event round-trip ✓.
5. ✅ **Both flagged ambiguities resolved positively**: `assistant.threads.setStatus` ("is thinking…") works in a regular private channel with plain `chat:write`, and `chat.startStream`/`appendStream`/`stopStream` streamed markdown into a thread there (recipient params required, as documented). Real incremental streaming is available — the chat.update fallback is not needed.
6. ⬜ `./model` injection candidates — untested (build-phase item, with resume-flow verification).

Operational facts captured: workspace is a real multi-person org → **private channels are mandatory** and all inbound gating is on a single Slack user ID (`<your-user-id>`, team `<your-team-id>`); both stored in the local env file with the tokens. Lesson from the run: never "pick first human" — the spike initially invited the wrong member (fixed: invited Sergej, removed her).

## Sources (primary)

- Channels: code.claude.com/docs/en/channels, /channels-reference
- Remote Control: code.claude.com/docs/en/remote-control
- Hooks: code.claude.com/docs/en/hooks (31 events; payload fields; global scope)
- Sessions/resume: code.claude.com/docs/en/sessions (same-ID resume; headless↔TUI interop)
- Slack: docs.slack.dev — conversations.\* (unarchive bot-token restriction is documented on the method page), chat.postMessage/update, chat.startStream/appendStream/stopStream (changelog 2025-10-07), assistant.threads.setStatus (changelog 2026-03-05), table block (changelog 2025-08-14), Socket Mode, rate-limit changelog 2025-05-29
- Official channel plugin sources: github.com/anthropics/claude-plugins-official (external_plugins: telegram, discord, imessage, fakechat)
