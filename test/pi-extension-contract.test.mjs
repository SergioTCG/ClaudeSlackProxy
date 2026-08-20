import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const launcher = fs.readFileSync(new URL('../bin/sab-pi', import.meta.url), 'utf8')
const extension = fs.readFileSync(new URL('../pi/sab-extension.ts', import.meta.url), 'utf8')
const managed = fs.readFileSync(new URL('../pi/managed-run.ts', import.meta.url), 'utf8')
const managedChild = fs.readFileSync(new URL('../pi/managed-child-output.ts', import.meta.url), 'utf8')
const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')

test('Pi bridge extension is explicit and bridge safe mode never leaks to the Pi CLI', () => {
  assert.match(launcher, /pi --extension "\$EXTENSION"/)
  assert.match(launcher, /if \[ "\$arg" = "--safe" \]/)
  assert.doesNotMatch(launcher, /pi install/)
})

test('Pi transport uses native events and structured images without session-file parsing', () => {
  assert.match(extension, /pi\.sendUserMessage/)
  assert.match(extension, /mimeType: file\.mimetype/)
  assert.match(extension, /data: fs\.readFileSync/)
  assert.match(extension, /pi\.on\("agent_settled"/)
  assert.match(extension, /event: "AgentStart"/)
  assert.doesNotMatch(extension, /readFileSync\([^\n]*session_file/)
})

test('Pi safe-mode permission failures block tool execution', () => {
  assert.match(extension, /if \(!SAFE_MODE\) return undefined/)
  assert.match(extension, /return \{ block: true, reason: "Slack permission relay was unavailable\." \}/)
})

test('Pi managed runs and adaptive routing persist state and isolate child agents from the bridge', () => {
  assert.match(managed, /sab-managed-run/)
  assert.match(managed, /sab-managed-policy/)
  assert.match(managed, /sab-managed-route/)
  assert.match(managed, /sab_goal/)
  assert.match(managed, /sab_subagent/)
  assert.match(managed, /--no-extensions/)
  assert.match(managed, /--extension", MANAGED_CHILD_EXTENSION/)
  assert.match(managed, /structuredChildSubmission/)
  assert.match(managed, /after one repair attempt/)
  assert.match(managedChild, /sab_submit_plan/)
  assert.match(managedChild, /sab_submit_review/)
  assert.match(managedChild, /terminate: true/)
  assert.match(managed, /SLACK_\|CODEX_\|CLAUDE_CODE_/)
  assert.match(managed, /"ManagedStatus"/)
  assert.match(managed, /"ManagedPlan"/)
  assert.match(managed, /"ManagedChildUsage"/)
  assert.match(managed, /"ManagedRouting"/)
  assert.match(managed, /--no-tools/)
  assert.match(managed, /--thinking", "low"/)
  assert.match(extension, /createManagedRunner/)
  assert.match(extension, /managed\.routePrompt/)
  assert.match(extension, /managed Pi run owns this session/)
  assert.match(daemon, /privateContext: artifactDeliveryContext/)
  assert.match(daemon, /route: sender \? 'native' : null/)
  assert.match(daemon, /Promoted to a managed Pi run/)
  assert.match(daemon, /ordinary prompts resume after it completes or is cancelled/)
})
