# Release checklist

## Repository and compatibility

- [ ] Release branch starts at the last known-good tag and is clean.
- [ ] Version, changelog, repository URLs, GitHub description, and topics agree.
- [ ] `AGENTS.md`, `CLAUDE.md`, README, architecture, security, and migration
      guide describe the same provider and safety contracts.
- [ ] `slack/app-manifest.json` is the sole Slack manifest.
- [ ] `/cc-*`, `/codex-*`, and `/pi-*` command namespaces match the documented release contract.
- [ ] The existing Slack app has all commands from the canonical manifest; no
      second app, token set, or daemon exists.
- [ ] `sab-cc`, `sab-codex`, `sab-pi`, and `sab-upload` work, and `ccs` /
      `ccs-codex` forward all args.
- [ ] Legacy state, config, checkout, control-channel, and LaunchAgent identities
      are covered by tests.
- [ ] No secrets, local state, logs, or generated files are tracked.

## Automated validation

- [ ] `npm ci`
- [ ] `npm run audit` reports zero known production vulnerabilities.
- [ ] `npm test`
- [ ] `npm run check`
- [ ] JavaScript syntax checks pass.
- [ ] Shellcheck passes at warning severity.
- [ ] The installed Pi version loads `pi/sab-extension.ts` and lists models in
      offline mode without changing Pi's global configuration.
- [ ] `node scripts/smoke-pi-managed.mjs` completes against a disposable Git
      fixture and mock loopback bridge without registering a child Slack leg.
- [ ] Installer help and provider selection pass on a clean shell.
- [ ] CI passes on the release commit.

## Installation matrix

- [ ] Upgrade an existing Claude-only installation.
- [ ] Upgrade an existing Claude plus Codex installation.
- [ ] Fresh Claude-only installation.
- [ ] Fresh Codex-only installation.
- [ ] Fresh dual-provider installation.
- [ ] Upgrade an existing Claude plus Codex installation with Pi staged separately.
- [ ] Fresh Pi-only installation.
- [ ] Fresh all-provider installation; historical `both` still excludes Pi.
- [ ] Re-running each installer is idempotent.
- [ ] `install-codex.sh` does not reload or rewrite the live LaunchAgent.
- [ ] `install-pi.sh` does not reload or rewrite the live LaunchAgent.
- [ ] No scenario creates a second daemon, control channel, or hook entry.

## Controlled live canary

- [ ] Back up `~/.config/ccs` locally with restrictive permissions.
- [ ] Record the previous release tag and rollback commands.
- [ ] Confirm no active turn is in progress before restart.
- [ ] Exactly one daemon connects with the production Socket Mode token.
- [ ] Existing and fresh Claude sessions send and receive Slack messages.
- [ ] Claude login-expired and API-overloaded turns surface immediately in
      Slack even when the CLI emits no `Stop`; repeated identical failures are
      deduplicated and the live working message is cleared.
- [ ] Existing and fresh Codex sessions send and receive Slack messages.
- [ ] Existing and fresh Pi sessions send and receive Slack messages.
- [ ] Claude, Codex, and Pi terminal-close → Slack-prompt → Ghostty-resume works.
- [ ] Topics include folder, branch, model, and reasoning effort.
- [ ] Restarting with unchanged metadata does not write channel topics again.
- [ ] Claude, Codex, and Pi usage reports and live time/token status work; local
      Pi models retain zero cost and report current context.
- [ ] File transfer, interrupt, model, effort, flags, and update commands work.
- [ ] Pi accepts a native image on an image-capable model and rejects it visibly
      on a text-only model; non-image attachments remain readable by local path.
- [ ] Pi `--safe` approves and denies tool calls from Slack and fails closed when
      the relay is interrupted; project-resource trust remains a separate prompt.
- [ ] `/pi-run` auto and plan/approve modes publish plans, show live
      phase/step/role/counters, survive pause/resume and terminal resume, enforce
      each budget, report failures visibly, run independent review, and mirror
      exactly one final response.
- [ ] Ordinary owner Pi prompts classify under the default `auto` policy: a
      simple prompt stays native and a complex write task promotes exactly
      once. `always`, `native`, and `direct` work and persist as documented;
      collaborators remain native.
- [ ] Adaptive classification receives no upload grant or attachment bytes,
      uses no tools/project resources, fails toward managed execution, reports
      promotion/cancellation visibly, and resumes one pending route after close.
- [ ] Managed planner/scout/reviewer children make no writes and never create a
      Slack channel. `--safe` rejects worker children while the parent remains
      behind Slack approval; cancel terminates an active child promptly.
- [ ] Claude → Codex and Codex → the original Claude leg preserve one channel,
      provider-native IDs/settings, queued-message order, and topic metadata.
- [ ] Claude ↔ Pi, Codex ↔ Pi, and a three-leg round trip preserve one active
      leg, every native ID/settings set, queued-message order, and topic metadata.
- [ ] Target-start failure rolls back to the source; daemon restart during
      target validation reaps the provisional tmux and restores one active leg.
- [ ] Instruction alignment preview/apply and switch-without-alignment work;
      stale hashes, traversal, symlink, binary, mode, and oversized proposals fail closed.
- [ ] Owner and collaborator artifact returns work; expired/replayed grants and
      workspace/symlink escapes are rejected.
- [ ] Claude/Codex permission relay and Pi safe-mode relay are exercised in
      non-destructive test sessions.
- [ ] No duplicate Slack channels appear.

## Publish

- [ ] Rename the GitHub repository only after old-remote migration is ready.
- [ ] Set the GitHub description and topics.
- [ ] Push the release branch and wait for CI.
- [ ] Publish `vX.Y.Z-rc.N` as a prerelease.
- [ ] Dogfood the RC before promoting the exact tested commit to `vX.Y.Z`.
- [ ] Keep the previous release tag and local backup until final acceptance.
