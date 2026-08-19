# Pi provider feasibility and implementation

## Conclusion

Pi can be a first-class Slack Agent Bridge provider without emulating Claude
Code or Codex. The viable integration is Pi's normal interactive TUI plus one
explicitly loaded, bridge-owned native extension. This preserves the visible
Ghostty/tmux session, native Pi session persistence, local inference, model
registry, thinking controls, and extension ecosystem while giving the daemon a
stable message and lifecycle API.

The implementation was developed against Pi 0.84.2 and the native extension
surface exposed by `@earendil-works/pi-coding-agent`. Pi is evolving quickly,
so every Pi upgrade needs the extension-loading smoke test in the release
checklist before a production roll.

## Adapter choice

Three approaches were considered:

1. Parsing the terminal or Pi session JSONL was rejected. Both are presentation
   or storage details, not stable integration contracts.
2. Running Pi permanently in RPC mode would provide control but would replace
   the normal interactive TUI and weaken the project's visible-terminal
   invariant.
3. Loading a trusted native extension into the normal Pi TUI provides inbound
   messages, lifecycle events, final assistant text, token usage, model and
   thinking controls, native images, tool-call interception, and session IDs.

The third approach is implemented in `pi/sab-extension.ts`. `sab-pi` always
passes it explicitly with `--extension`; it is not installed in Pi's global or
project configuration. Unbridged `pi` commands are therefore unaffected, and a
checked-out release fully defines the adapter code that it runs.

## Capability mapping

| Bridge capability | Pi mechanism |
|---|---|
| Session identity and resume | `sessionManager.getSessionId()` and `pi --session <id>` |
| Slack prompt injection | extension SSE plus `sendUserMessage()` |
| Image input | structured native image content when the selected model advertises `image` input |
| Other Slack files | local paths in the accepted prompt, matching existing provider behavior |
| Final response | `message_end` plus `agent_settled` |
| Working status | native usage events, elapsed timer, and context percentage |
| Usage reports | content-free aggregate ledger in bridge state; no Pi transcript parsing |
| Model catalog/change | `modelRegistry.getAvailable()` and `setModel()` |
| Thinking change | `setThinkingLevel()` |
| Interrupt | extension context `abort()` |
| CLI update | `pi update self`, followed by native-session resume |
| Artifact return | unchanged `sab-upload` one-use grant path |
| Provider handoff | the existing transactional lineage, handoff, validation, and rollback protocol |

Pi usage is captured from native provider usage objects. Local models normally
report zero monetary cost, which is retained rather than presented as missing.
The ledger contains timestamps, session IDs, working directories, models, token
counts, context metrics, and cost totals—never prompt or response content.

## Permissions and project trust

Pi's built-in coding tools are unrestricted by default. There is no native flag
whose meaning precisely matches Claude `--dangerously-skip-permissions` or
Codex `--yolo`; Pi's default is already the unattended behavior.

SAB adds an optional `--safe` launcher flag. It is consumed by `sab-pi`, not
passed to Pi, and makes every Pi `tool_call` wait for an owner decision in
Slack. Failure, timeout, identity mismatch, or daemon loss blocks the tool.
This differs intentionally from Codex's local fallback: a bridge-added safety
mode must fail closed.

Pi's native `--approve` and `--no-approve` flags concern project-local
resources—settings, extensions, skills, and packages—not built-in tool access.
When Pi asks for project trust in a remotely spawned or switched session, the
extension relays that separate decision to Slack. The prompt warns that trusted
project extensions execute with the macOS user's permissions. `AGENTS.md` and
`CLAUDE.md` loading follows Pi's own trust contract.

## Three-provider switching

A lineage now has lazy Claude, Codex, and Pi legs while retaining exactly one
active provider. Existing version-1 two-leg lineages gain a null Pi leg only
when touched; old sessions still omit `provider` and remain Claude.

Commands name the target when it is ambiguous:

- `/cc-switch [codex|pi] [new]` (bare form still defaults to Codex);
- `/codex-switch [claude|pi] [new]` (bare form still defaults to Claude);
- `/pi-switch <claude|codex> [new]`.

Provider-native flags, model, thinking/effort, session ID, and credentials are
never translated. Pi participates in the same private handoff, instruction
preflight, provisional target, read-only validation, atomic commit, and rollback
protocol. Pi readiness is proven by both a session-start claim and the live
extension stream rather than terminal text.

## Operational requirements and limits

- Apply the canonical Slack manifest once to the existing app to register the
  eleven `/pi-*` commands. No OAuth scope, token, app, daemon, port, or state
  directory change is required.
- `install-pi.sh` stages Pi support without restarting the daemon. A live roll
  remains a separate maintenance action.
- The selected Pi model decides whether native image input and reasoning are
  available. The bridge reports an explicit Slack error when an image is sent
  to a text-only model.
- Pi has no direct `--chrome` counterpart. Browser use requires a configured Pi
  tool/extension or other integration.
- The first production release should remain an RC until new/resume, settings,
  usage, safe mode, images, artifact return, and every switch direction have
  passed controlled Slack canaries.
