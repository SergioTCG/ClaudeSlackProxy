import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginTransition, commitTransition, deleteLineage, enqueueTransitionItem, ensureLineage, lineageFor,
  rebindLineageSession, recoveryDecision, rollbackTransition, setTransitionPhase, transitionForTarget,
  standbyForSession,
} from '../daemon/lineage.mjs'

const legacyState = () => ({
  sessions: { old: { id: 'old', cwd: '/tmp/repo', channel: 'C1' } },
  channels: { C1: 'old' }, channelTmux: { C1: 'ccs-old' }, whitelist: {},
})

test('legacy sessions get a Claude lineage lazily on first switch only', () => {
  const state = legacyState()
  assert.equal(state.lineages, undefined)
  const lineage = ensureLineage(state, 'C1', state.sessions.old)
  assert.deepEqual(lineage.legs, { claude: 'old', codex: null, pi: null })
  assert.equal(lineage.activeProvider, 'claude')
  assert.equal(lineageFor(state, 'C1'), lineage)
})

test('existing two-provider lineages gain an empty Pi leg only when touched', () => {
  const state = legacyState()
  state.lineages = { C1: { version: 1, generation: 2, activeProvider: 'claude', legs: { claude: 'old', codex: 'cx' }, transition: null } }
  const lineage = ensureLineage(state, 'C1', state.sessions.old)
  assert.equal(lineage.version, 2)
  assert.deepEqual(lineage.legs, { claude: 'old', codex: 'cx', pi: null })
})

test('a transition preserves provider-native target flags and exact tmux matching', () => {
  const state = legacyState()
  const transition = beginTransition(state, 'C1', state.sessions.old, {
    id: 'switch-1', now: 10, targetFlags: ['--dangerously-bypass-approvals-and-sandbox'],
  })
  assert.equal(transition.target.provider, 'codex')
  assert.equal(transition.target.kind, 'new')
  assert.deepEqual(transition.target.effectiveFlags, ['--dangerously-bypass-approvals-and-sandbox'])
  setTransitionPhase(state.lineages.C1, 'target_starting', {
    target: { ...transition.target, tmux: 'ccs-switch-1' },
  }, 20)
  assert.equal(transitionForTarget(state, 'codex', 'ccs-switch-1')?.channel, 'C1')
  assert.equal(transitionForTarget(state, 'claude', 'ccs-switch-1'), null)
  assert.equal(transitionForTarget(state, 'codex', 'wrong'), null)
})

test('a transition can explicitly target Pi without disturbing the Codex standby leg', () => {
  const state = legacyState()
  state.sessions.cx = { id: 'cx', provider: 'codex', cwd: '/tmp/repo', channel: null }
  const lineage = ensureLineage(state, 'C1', state.sessions.old)
  lineage.legs.codex = 'cx'
  assert.throws(() => beginTransition(state, 'C1', state.sessions.old, { targetProvider: 'claude' }), /active provider/)
  const transition = beginTransition(state, 'C1', state.sessions.old, {
    id: 'to-pi', targetProvider: 'pi', targetFlags: ['--safe'],
  })
  assert.equal(transition.target.provider, 'pi')
  assert.equal(transition.target.sid, null)
  assert.equal(lineage.legs.codex, 'cx')
})

test('commit makes exactly the target leg active and supports a round trip', () => {
  const state = legacyState()
  let transition = beginTransition(state, 'C1', state.sessions.old, { id: 'to-codex' })
  state.sessions.cx = { id: 'cx', provider: 'codex', cwd: '/tmp/repo', channel: null }
  transition.target.sid = 'cx'
  commitTransition(state, 'C1', state.sessions.cx, 50)
  assert.equal(state.channels.C1, 'cx')
  assert.equal(state.sessions.old.channel, null)
  assert.equal(state.sessions.cx.channel, 'C1')
  assert.deepEqual(state.lineages.C1.legs, { claude: 'old', codex: 'cx', pi: null })

  transition = beginTransition(state, 'C1', state.sessions.cx, { id: 'to-claude', targetFlags: ['--chrome'] })
  assert.equal(transition.target.sid, 'old')
  assert.equal(transition.target.kind, 'resume')
  commitTransition(state, 'C1', state.sessions.old, 60)
  assert.equal(state.channels.C1, 'old')
  assert.equal(state.sessions.old.channel, 'C1')
  assert.equal(state.sessions.cx.channel, null)
  assert.equal(state.lineages.C1.generation, 2)
  assert.equal(standbyForSession(state, 'cx').provider, 'codex')
  assert.equal(standbyForSession(state, 'old'), null)
})

test('a three-provider lineage preserves every native leg while rotating the active mapping', () => {
  const state = legacyState()
  let transition = beginTransition(state, 'C1', state.sessions.old, { id: 'to-pi', targetProvider: 'pi' })
  state.sessions.pi1 = { id: 'pi1', provider: 'pi', cwd: '/tmp/repo', channel: null }
  transition.target.sid = 'pi1'
  commitTransition(state, 'C1', state.sessions.pi1)

  transition = beginTransition(state, 'C1', state.sessions.pi1, { id: 'to-codex', targetProvider: 'codex' })
  state.sessions.cx = { id: 'cx', provider: 'codex', cwd: '/tmp/repo', channel: null }
  transition.target.sid = 'cx'
  commitTransition(state, 'C1', state.sessions.cx)

  transition = beginTransition(state, 'C1', state.sessions.cx, { id: 'to-claude', targetProvider: 'claude' })
  assert.equal(transition.target.sid, 'old')
  commitTransition(state, 'C1', state.sessions.old)
  assert.deepEqual(state.lineages.C1.legs, { claude: 'old', codex: 'cx', pi: 'pi1' })
  assert.equal(state.lineages.C1.activeProvider, 'claude')
  assert.equal(state.channels.C1, 'old')
  assert.equal(state.sessions.old.channel, 'C1')
  assert.equal(state.sessions.cx.channel, null)
  assert.equal(state.sessions.pi1.channel, null)
})

test('rollback restores the source mapping without discarding a native target leg', () => {
  const state = legacyState()
  const transition = beginTransition(state, 'C1', state.sessions.old, { id: 'switch-1' })
  state.sessions.cx = { id: 'cx', provider: 'codex', cwd: '/tmp/repo', channel: null }
  transition.target.sid = 'cx'
  transition.target.tmux = 'ccs-provisional'
  const source = rollbackTransition(state, 'C1', 'target failed', 99)
  assert.equal(source.id, 'old')
  assert.equal(state.channels.C1, 'old')
  assert.equal(state.sessions.cx.channel, null)
  assert.equal(state.lineages.C1.legs.codex, 'cx')
  assert.equal(state.lineages.C1.transition, null)
})

test('cleanup deletes every leg in a channel lineage', () => {
  const state = legacyState()
  const transition = beginTransition(state, 'C1', state.sessions.old)
  state.sessions.cx = { id: 'cx', provider: 'codex', cwd: '/tmp/repo', channel: null }
  transition.target.sid = 'cx'
  commitTransition(state, 'C1', state.sessions.cx)
  assert.deepEqual(deleteLineage(state, 'C1').sort(), ['cx', 'old'])
  assert.deepEqual(state.sessions, {})
  assert.equal(state.channels.C1, undefined)
  assert.equal(state.lineages.C1, undefined)
})

test('restart recovery rolls all phases back and only reaps a live provisional target', () => {
  assert.deepEqual(recoveryDecision({ phase: 'handoff', target: {} }), {
    action: 'rollback', killTargetTmux: false,
  })
  assert.deepEqual(recoveryDecision({ phase: 'target_validating', target: { tmux: 'ccs-new' } }, { targetTmuxAlive: true }), {
    action: 'rollback', killTargetTmux: true, targetTmux: 'ccs-new',
  })
})

test('transition messages journal in arrival order for post-commit delivery', () => {
  const state = legacyState()
  const transition = beginTransition(state, 'C1', state.sessions.old)
  assert.equal(enqueueTransitionItem(transition, { text: 'one' }, 2), 1)
  assert.equal(enqueueTransitionItem(transition, { text: 'two' }, 2), 2)
  assert.throws(() => enqueueTransitionItem(transition, { text: 'three' }, 2), /full/)
  rollbackTransition(state, 'C1', 'cancelled')
  assert.deepEqual(state.lineages.C1.pendingDelivery.map(item => item.text), ['one', 'two'])
})

test('native clear/rebind updates lineage and an in-flight source reference', () => {
  const state = legacyState()
  beginTransition(state, 'C1', state.sessions.old, { id: 'switch-1' })
  rebindLineageSession(state, 'old', 'fresh', 'claude')
  assert.equal(state.lineages.C1.legs.claude, 'fresh')
  assert.equal(state.lineages.C1.transition.source.sid, 'fresh')
})
