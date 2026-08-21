import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptHookSettings, codexEffortFromArgs, codexEffortFromToml,
  CODEX_DANGEROUS_FLAG, codexFlagsWithoutInitialPrompt, codexPermissionDecision,
  codexStatusRecoveryDecision, defaultNewFlagsFor, displayFlagsFor, isPathWithin,
  isSupersededHook, normalizeLaunchFlag,
  parseSlackCommand, providerOf, resolveCodexEffort, resumeArgsFor, slackCommand,
  switchActionBlocks, switchTargetLaunch, targetStartupState, waitForTargetSessionClaim,
  submitTargetValidation, waitForCodexInterrupt,
} from '../daemon/providers.mjs'

test('legacy sessions remain Claude without a state migration', () => {
  assert.equal(providerOf({ id: 'old-session' }), 'claude')
  assert.equal(providerOf({ id: 'new-session', provider: 'codex' }), 'codex')
  assert.equal(providerOf({ id: 'pi-session', provider: 'pi' }), 'pi')
  assert.equal(providerOf({ id: 'unknown', provider: 'other' }), 'claude')
})

test('Slack command namespace selects exactly one provider', () => {
  assert.deepEqual(parseSlackCommand('/cc-new'), { provider: 'claude', name: 'new' })
  assert.deepEqual(parseSlackCommand('/codex-model'), { provider: 'codex', name: 'model' })
  assert.deepEqual(parseSlackCommand('/pi-effort'), { provider: 'pi', name: 'effort' })
  assert.equal(parseSlackCommand('/cc_foo'), null)
  assert.equal(parseSlackCommand('/other-new'), null)
  assert.equal(slackCommand('claude', 'status'), '/cc-status')
  assert.equal(slackCommand('codex', 'status'), '/codex-status')
  assert.equal(slackCommand('pi', 'status'), '/pi-status')
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

test('Pi flags separate project trust and bridge safe mode from unrestricted native tools', () => {
  assert.equal(normalizeLaunchFlag('pi', '--approve'), '--approve')
  assert.equal(normalizeLaunchFlag('pi', '--no-approve'), '--no-approve')
  assert.equal(normalizeLaunchFlag('pi', '--safe'), '--safe')
  assert.equal(normalizeLaunchFlag('pi', '--model=qwen38-local/qwen3.8-27b'), '--model=qwen38-local/qwen3.8-27b')
  assert.equal(normalizeLaunchFlag('pi', '--thinking=xhigh'), '--thinking=xhigh')
  assert.equal(normalizeLaunchFlag('pi', '--thinking=extreme'), null)
  assert.equal(normalizeLaunchFlag('pi', '--api-key=secret'), null)
  assert.equal(normalizeLaunchFlag('pi', '--extension=/tmp/evil.ts'), null)
  assert.equal(normalizeLaunchFlag('pi', '--yolo'), null)
  assert.equal(normalizeLaunchFlag('pi', '--dsp'), null)
})

test('provider new-session defaults mirror dangerous-mode aliases', () => {
  assert.deepEqual(defaultNewFlagsFor('claude', {}), ['--dangerously-skip-permissions'])
  assert.deepEqual(defaultNewFlagsFor('codex', {}), [CODEX_DANGEROUS_FLAG])
  assert.deepEqual(defaultNewFlagsFor('pi', {}), [])
  assert.deepEqual(defaultNewFlagsFor('codex', { CCS_CODEX_NEW_FLAGS: '--search' }), ['--search'])
  assert.deepEqual(defaultNewFlagsFor('pi', { CCS_PI_NEW_FLAGS: '--safe --offline' }), ['--safe', '--offline'])
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

test('Pi resume args preserve native settings and resume the exact session id', () => {
  const session = {
    id: 'pi-123', provider: 'pi',
    launchFlags: '--safe --offline --model=old --thinking=low',
    model: 'qwen38-local/qwen3.8-27b', effort: 'xhigh',
  }
  assert.deepEqual(resumeArgsFor(session), [
    '--safe', '--offline', '--model=qwen38-local/qwen3.8-27b', '--thinking=xhigh',
    '--session', 'pi-123',
  ])
  assert.deepEqual(displayFlagsFor({ ...session, launchFlags: '--safe --session pi-123' }), ['--safe'])
  assert.deepEqual(resumeArgsFor({ id: 'pi-456', provider: 'pi' }), ['--session', 'pi-456'])
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
  assert.deepEqual(switchTargetLaunch('pi', null, { CCS_PI_NEW_FLAGS: '--safe' }), {
    kind: 'new', args: ['--safe'], effectiveFlags: ['--safe'],
  })
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

test('Codex target readiness ignores blank rows below the UI in a tall terminal', () => {
  const ready = `OpenAI Codex (v0.147.0)
› Find and fix a bug in @filename
gpt-5.6-sol xhigh · ~/Code/Barrique${'\n'.repeat(40)}`

  assert.equal(targetStartupState('codex', ready), 'ready')
})

test('Codex interrupt reconciliation accepts the normal Stop hook', async () => {
  const session = { codexTurnStartedAt: 100 }
  const result = await waitForCodexInterrupt(session, {
    attempts: 2,
    getPane: async () => 'still working · esc to interrupt',
    sleepFn: async () => { delete session.codexTurnStartedAt },
  })

  assert.equal(result, 'hook')
})

test('Codex interrupt reconciliation accepts the idle input surface when Stop is omitted', async () => {
  const session = { codexTurnStartedAt: 100 }
  const pane = `■ Conversation interrupted - tell the model what to do differently.\n` +
    `› Improve documentation in @filename\n` +
    `  gpt-5.6-sol xhigh · ~/Code/Barrique`

  assert.equal(await waitForCodexInterrupt(session, {
    attempts: 1,
    getPane: async () => pane,
  }), 'idle')
  assert.equal(session.codexTurnStartedAt, 100)
})

test('Codex interrupt reconciliation does not clear a newer turn', async () => {
  const session = { codexTurnStartedAt: 100 }
  const result = await waitForCodexInterrupt(session, {
    attempts: 2,
    getPane: async () => 'still working · esc to interrupt',
    sleepFn: async () => { session.codexTurnStartedAt = 200 },
  })

  assert.equal(result, 'superseded')
  assert.equal(session.codexTurnStartedAt, 200)
})

test('Codex interrupt reconciliation reports an unconfirmed interrupt', async () => {
  const session = { codexTurnStartedAt: 100 }
  let sleeps = 0
  const result = await waitForCodexInterrupt(session, {
    attempts: 3,
    getPane: async () => 'still working · esc to interrupt',
    sleepFn: async () => { sleeps++ },
  })

  assert.equal(result, 'timeout')
  assert.equal(sleeps, 2)
  assert.equal(session.codexTurnStartedAt, 100)
})

test('Codex status recovery clears an orphaned turn once the TUI is idle', () => {
  const idle = `■ Conversation interrupted\n` +
    `› Improve documentation in @filename\n` +
    `  gpt-5.6-sol xhigh · ~/Code/Barrique`
  const working = `› queued input\n` +
    `• Working (8s · esc to interrupt)\n` +
    `  gpt-5.6-sol xhigh · ~/Code/Barrique`

  assert.equal(codexStatusRecoveryDecision({ codexTurnStartedAt: 100 }, idle), 'clear')
  assert.equal(codexStatusRecoveryDecision({ codexTurnStartedAt: 100 }, working), 'resume')
  assert.equal(codexStatusRecoveryDecision({}, idle), 'clear')
})

test('Pi target readiness never trusts terminal text in place of its native stream', () => {
  assert.equal(targetStartupState('pi', '❯ \nshift+tab to cycle\nbypass permissions'), 'starting')
  assert.equal(targetStartupState('pi', 'Trust project resources?'), 'trust')
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

test('target validation preserves provider-specific claim and injection order', async () => {
  for (const [provider, expected] of [['claude', ['inject', 'claim']], ['codex', ['inject', 'claim']], ['pi', ['claim', 'inject']]]) {
    const events = []
    await submitTargetValidation(provider, {
      waitForClaim: async () => { events.push('claim') },
      inject: async () => { events.push('inject') },
    })
    assert.deepEqual(events, expected, provider)
  }
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
