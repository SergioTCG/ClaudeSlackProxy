import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptHookSettings, codexEffortFromArgs, codexEffortFromToml,
  codexPermissionDecision, displayFlagsFor, isPathWithin,
  isSupersededHook, normalizeLaunchFlag,
  parseSlackCommand, providerOf, resolveCodexEffort, resumeArgsFor, slackCommand,
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
  assert.equal(normalizeLaunchFlag('codex', '--sandbox=workspace-write'), '--sandbox=workspace-write')
  assert.equal(normalizeLaunchFlag('codex', '--model'), null)
  assert.equal(normalizeLaunchFlag('codex', '--config=features.hooks=false'), null)
  assert.equal(normalizeLaunchFlag('codex', '--add-dir=/'), null)
  assert.equal(normalizeLaunchFlag('codex', '--dangerously-bypass-hook-trust'), null)
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
