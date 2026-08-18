import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptHookSettings, codexEffortFromArgs, codexEffortFromToml,
  CODEX_DANGEROUS_FLAG, codexFlagsWithoutInitialPrompt, codexPermissionDecision,
  defaultNewFlagsFor, displayFlagsFor, isPathWithin,
  isSupersededHook, normalizeLaunchFlag,
  parseSlackCommand, providerOf, resolveCodexEffort, resumeArgsFor, slackCommand,
  switchActionBlocks, switchTargetLaunch, targetStartupState, waitForTargetSessionClaim,
} from '../daemon/providers.mjs'

test('legacy sessions remain Claude without a state migration', () => {
  assert.equal(providerOf({ id: 'old-session' }), 'claude')
  assert.equal(providerOf({ id: 'new-session', provider: 'codex' }), 'codex')
  assert.equal(providerOf({ id: 'unknown', provider: 'other' }), 'claude')
})

test('Slack command namespace selects exactly one provider', () => {
  assert.deepEqual(parseSlackCommand('/cc-new'), { provider: 'claude', name: 'new' })
  assert.deepEqual(parseSlackCommand('/codex-model'), { provider: 'codex', name: 'model' })
  assert.equal(parseSlackCommand('/cc_foo'), null)
  assert.equal(parseSlackCommand('/other-new'), null)
  assert.equal(slackCommand('claude', 'status'), '/cc-status')
  assert.equal(slackCommand('codex', 'status'), '/codex-status')
})

test('Claude flag normalization preserves the existing alias', () => {
  assert.equal(normalizeLaunchFlag('claude', '--dsp'), '--dangerously-skip-permissions')
  assert.equal(normalizeLaunchFlag('claude', '--chrome'), '--chrome')
  assert.equal(normalizeLaunchFlag('claude', '--search'), null)
})

test('Codex flags require an allowlisted switch or inline value', () => {
  assert.equal(normalizeLaunchFlag('codex', '--search'), '--search')
  assert.equal(normalizeLaunchFlag('codex', '--yolo'), CODEX_DANGEROUS_FLAG)
  assert.equal(normalizeLaunchFlag('codex', CODEX_DANGEROUS_FLAG), CODEX_DANGEROUS_FLAG)
  assert.equal(normalizeLaunchFlag('codex', '--sandbox=workspace-write'), '--sandbox=workspace-write')
  assert.equal(normalizeLaunchFlag('codex', '--model'), null)
  assert.equal(normalizeLaunchFlag('codex', '--config=features.hooks=false'), null)
  assert.equal(normalizeLaunchFlag('codex', '--add-dir=/'), null)
  assert.equal(normalizeLaunchFlag('codex', '--dangerously-bypass-hook-trust'), null)
})

test('provider new-session defaults mirror dangerous-mode aliases', () => {
  assert.deepEqual(defaultNewFlagsFor('claude', {}), ['--dangerously-skip-permissions'])
  assert.deepEqual(defaultNewFlagsFor('codex', {}), [CODEX_DANGEROUS_FLAG])
  assert.deepEqual(defaultNewFlagsFor('codex', { CCS_CODEX_NEW_FLAGS: '--search' }), ['--search'])
})

test('Codex launch metadata excludes the optional resume prompt', () => {
  const sid = '019fff4d-9217-7ee1-825d-528aec50a0e9'
  const flags = `resume --search ${sid} wake from Slack with spaces`
  assert.equal(codexFlagsWithoutInitialPrompt(flags, sid), `resume --search ${sid}`)
  assert.equal(codexFlagsWithoutInitialPrompt('--search', sid), '--search')
})

test('Claude resume args keep legacy behavior', () => {
  assert.deepEqual(resumeArgsFor({
    id: 'abc', launchFlags: '--chrome --continue --effort low', effort: 'high',
  }), ['--chrome', '--effort', 'high', '--resume', 'abc'])
  assert.deepEqual(resumeArgsFor({ id: 'abc' }), ['--dangerously-skip-permissions', '--resume', 'abc'])
})

test('Codex resume args use the subcommand and preserve provider settings', () => {
  const session = {
    id: 'thr-123', provider: 'codex',
    launchFlags: '--search --model=old --config=model_reasoning_effort="low"',
    model: 'gpt-5.6-sol', effort: 'high',
  }
  assert.deepEqual(resumeArgsFor(session), [
    'resume', '--search', '--model', 'gpt-5.6-sol',
    '--config', 'model_reasoning_effort="high"', 'thr-123',
  ])
  assert.deepEqual(displayFlagsFor({ ...session, launchFlags: 'resume --search thr-123' }), ['--search'])
  assert.deepEqual(resumeArgsFor({ id: 'thr-456', provider: 'codex' }), [
    'resume', CODEX_DANGEROUS_FLAG, 'thr-456',
  ])
  assert.deepEqual(resumeArgsFor({ id: 'thr-789', provider: 'codex' }, {
    initialPrompt: 'wake from Slack\nwith the full message',
  }), [
    'resume', CODEX_DANGEROUS_FLAG, 'thr-789', 'wake from Slack\nwith the full message',
  ])
})

test('provider switching resumes native settings or uses target defaults without translation', () => {
  assert.deepEqual(switchTargetLaunch('codex', null, { CCS_CODEX_NEW_FLAGS: '--search --yolo' }), {
    kind: 'new', args: ['--search', '--yolo'], effectiveFlags: ['--search', '--yolo'],
  })
  const claude = { id: 'cc-1', launchFlags: '--chrome --dangerously-skip-permissions', effort: 'high' }
  assert.deepEqual(switchTargetLaunch('claude', claude, {}), {
    kind: 'resume',
    args: ['--chrome', '--dangerously-skip-permissions', '--effort', 'high', '--resume', 'cc-1'],
    effectiveFlags: ['--chrome', '--dangerously-skip-permissions'],
  })
  assert.throws(() => switchTargetLaunch('codex', claude), /mismatch/)
})

test('provider switch buttons have unique Slack action IDs', () => {
  const transition = { id: 'tx-1', target: { provider: 'codex' } }
  const preview = switchActionBlocks(transition, { safeToPropose: true })[0]
  const proposal = switchActionBlocks(transition, { safeToPropose: true }, 'proposal')[0]

  for (const block of [preview, proposal]) {
    const ids = block.elements.map(element => element.action_id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.every(id => /^provider_switch_(align|apply|continue|cancel)$/.test(id)))
  }
})

test('Codex target readiness uses the visible idle footer, not stale trust scrollback', () => {
  const ready = `Do you trust the contents of this directory?
Press enter to continue

OpenAI Codex (v0.147.0)
› Run /review on my current changes
gpt-5.6-sol xhigh · ~/Code/Barrique`
  const trust = `OpenAI Codex
Do you trust the contents of this directory?
› 1. Trust and continue
  2. Exit
Press enter to continue`

  assert.equal(targetStartupState('codex', ready), 'ready')
  assert.equal(targetStartupState('codex', trust), 'trust')
  assert.equal(targetStartupState('codex', 'Starting OpenAI Codex…'), 'starting')
  assert.equal(targetStartupState('claude', 'Claude Code\n❯\nshift+tab to cycle'), 'ready')
})

test('target validation requires a provider hook session claim', async () => {
  const transition = { target: { provider: 'codex', sid: null } }
  let waits = 0
  const claimed = await waitForTargetSessionClaim(transition, {
    attempts: 3,
    sleepFn: async () => { if (++waits === 2) transition.target.sid = 'codex-session' },
  })
  assert.equal(claimed, 'codex-session')
  await assert.rejects(() => waitForTargetSessionClaim({ target: { provider: 'codex', sid: null } }, {
    attempts: 2, sleepFn: async () => {},
  }), /Codex target hooks did not register/)
})

test('Codex effort is recovered from launch overrides and root config only', () => {
  assert.equal(codexEffortFromArgs('resume --config model_reasoning_effort="xhigh" thr-123'), 'xhigh')
  assert.equal(codexEffortFromArgs('-c=model_reasoning_effort=high --config other=value'), 'high')
  assert.equal(codexEffortFromToml(`
model_reasoning_effort = "xhigh"
[profiles.fast]
model_reasoning_effort = "low"
`), 'xhigh')
  assert.equal(codexEffortFromToml(`
model_reasoning_effort = "xhigh"
[profiles.fast]
model_reasoning_effort = "low"
`, 'profiles.fast'), 'low')
})

test('Codex effort follows user, profile, project, and CLI precedence', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-codex-effort-'))
  try {
    const home = path.join(temp, 'home')
    const repo = path.join(home, 'repo')
    const nested = path.join(repo, 'packages', 'app')
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.mkdirSync(path.join(repo, '.codex'), { recursive: true })
    fs.mkdirSync(path.join(nested, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `
model_reasoning_effort = "medium"
[profiles.deep]
model_reasoning_effort = "high"
`)
    fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n')
    fs.writeFileSync(path.join(nested, '.codex', 'config.toml'), 'model_reasoning_effort = "xhigh"\n')

    assert.equal(resolveCodexEffort({ launchFlags: '--profile deep', cwd: nested, home }), 'xhigh')
    assert.equal(resolveCodexEffort({
      launchFlags: '--profile deep --config model_reasoning_effort="low"', cwd: nested, home,
    }), 'low')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('Codex permission decisions use the documented hook shape', () => {
  assert.deepEqual(codexPermissionDecision('allow'), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  })
  assert.equal(codexPermissionDecision('deny').hookSpecificOutput.decision.message, 'Denied from Slack.')
})

test('an old SessionEnd cannot roll back settings during restart', () => {
  assert.equal(acceptHookSettings('SessionEnd', true), false)
  assert.equal(acceptHookSettings('Stop', true), false)
  assert.equal(acceptHookSettings('SessionStart', true), true)
  assert.equal(acceptHookSettings('SessionEnd', false), true)
})

test('a superseded process cannot mark its replacement dormant', () => {
  assert.equal(isSupersededHook('SessionEnd', 200, 100), true)
  assert.equal(isSupersededHook('Stop', 200, 100), true)
  assert.equal(isSupersededHook('SessionEnd', 100, 100), false)
  assert.equal(isSupersededHook('SessionStart', 200, 100), false)
})

test('home path containment rejects sibling-prefix escapes', () => {
  assert.equal(isPathWithin('/Users/test', '/Users/test/Code/project'), true)
  assert.equal(isPathWithin('/Users/test', '/Users/test-other/project'), false)
  assert.equal(isPathWithin('/Users/test', '/Users/test/../other'), false)
})
