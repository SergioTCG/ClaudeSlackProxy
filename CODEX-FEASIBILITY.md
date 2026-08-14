# Codex terminal support — feasibility study

*Investigated and implemented 2026-08-14 against Codex CLI 0.147.0 on macOS.*

## Verdict

**Feasible for the core bridge, without replacing or migrating the Claude path.**
Codex provides stable lifecycle hooks for session identity, terminal prompts,
final assistant text, and synchronous permission decisions. The existing tmux
layer already supplies the missing inbound transport and terminal control.

The safe design is a provider adapter, not a rewrite:

```text
Slack → daemon → tmux paste ─┬→ bin/ccs       → Claude Code
                             └→ bin/ccs-codex → Codex CLI

Claude → hooks + JSONL transcript + MCP Channel SSE → daemon → Slack
Codex  → lifecycle hooks (final text included)      → daemon → Slack
```

Existing state remains valid: a session without a `provider` field is Claude.
Only new Codex sessions store `provider: "codex"`. Raw session IDs and channel
mappings retain their current shape, so activation needs no state migration.

## Capability map

| Requirement | Codex mechanism | Result |
|---|---|---|
| New session/channel | `SessionStart` hook (`session_id`, `cwd`, `model`) | Implemented |
| Terminal prompt → Slack | `UserPromptSubmit.prompt` | Implemented |
| Slack prompt → terminal | Existing bracketed tmux paste | Implemented |
| Final response → Slack | `Stop.last_assistant_message` | Implemented without parsing Codex JSONL |
| Dormant-session resume | `codex resume <UUID>` in a new Ghostty/tmux window | Implemented |
| Approve/deny from Slack | Synchronous `PermissionRequest` hook; daemon holds the response until a Slack verdict | Implemented for non-yolo sessions; local prompt is the failure fallback |
| Interrupt turn | Launcher binds Codex `interrupt_turn` to F12; daemon sends F12 | Implemented |
| Model/reasoning control | Restart/resume with `--model` and `model_reasoning_effort` | Implemented |
| Model discovery | `codex debug models --bundled` | Implemented |
| File attachments | Existing Slack download + local-path prompt | Implemented |
| Live whimsical spinner / question-form scraping | Claude-TUI-specific pane grammar | Not claimed for Codex; a generic working status is shown |
| Usage/cost report | Existing `ccusage` scans Claude transcripts only | Not wired; use Codex `/usage` |
| Per-session subscription switch | Claude OAuth-token mechanism | Not applicable; Codex uses its current machine login |

## Why hooks + tmux, not app-server

Codex app-server could eventually provide richer structured turn events, but it
is a larger and more experimental control-plane dependency. Hooks are the
documented deterministic lifecycle surface, and tmux is already the bridge's
tested input/resurrection mechanism. This path therefore adds one small
provider branch while leaving Claude's MCP Channels integration intact.

Codex documents its transcript path as a convenience rather than a stable wire
format. The bridge consequently uses `Stop.last_assistant_message` and never
parses Codex JSONL. This trades mid-turn prose streaming for forward compatibility.

## Safety and rollout

- `bin/ccs`, `hooks/hook.sh`, Claude MCP Channels, and old state records keep
  their existing behavior.
- Codex is selected only by `ccs-codex`, `/codex-new <folder>`, or
  `POST /spawn` with `provider: "codex"`.
- Slack ingress is namespaced: `/cc-*` is always Claude and `/codex-*` is
  always Codex. Provider flags in slash commands are rejected, and a command
  from the wrong namespace cannot mutate the session in that channel.
- Codex hooks are installed separately by `install-codex.sh`; the main installer
  does not alter `~/.codex`.
- The Codex installer does not restart the daemon. Activation is a deliberate
  maintenance action.
- To mirror Claude's remote-control posture, flagless Slack spawns default to
  `--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Operators can replace
  it with explicit sandbox/approval flags or `CCS_CODEX_NEW_FLAGS`; the Slack
  permission relay applies when Codex is configured to request approval.
- The permission hook fails open to Codex's ordinary *local approval prompt*,
  not to automatic approval: `{}` means the bridge made no decision.
- `--dangerously-bypass-hook-trust` is not allowlisted. The operator reviews and
  trusts the exact hook definition with Codex `/hooks`, as the official flow
  requires.

Rollback is similarly narrow: stop starting Codex sessions, remove the
`ccs-codex` symlink and the exact hook entries from `~/.codex/hooks.json`, then
restart the daemon during a safe window. Claude sessions and state need no
conversion.

## Residual risks

1. Codex hooks are versioned product surface and may evolve; pinning a minimum
   supported CLI version should be considered before a broad release.
2. Hook trust is hash-based. Updating the relay can require review again in
   `/hooks`; until trusted, hooks are skipped and no Slack channel is created.
3. `PermissionRequest` deliberately waits for Slack for up to 9.5 minutes. A
   daemon outage or timeout returns no decision and leaves approval in the TUI.
4. `SessionEnd` is advisory and may be delayed; the existing PID liveness sweep
   remains the reliable dormant-session fallback.
5. Core behavior has offline contract/syntax coverage, but a real Codex session,
   Slack channel, permission prompt, and resume should be smoke-tested only
   after the operator approves a daemon restart.

## Primary references

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
