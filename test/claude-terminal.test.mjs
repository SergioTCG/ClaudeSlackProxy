import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_FAILURE_DEDUPE_MS,
  claudePollerDecision,
  claudeTerminalFailureBatch,
  prepareClaudeTerminalDelivery,
} from '../daemon/claude-terminal.mjs'

const LOGIN = 'Login expired · Please run /login'
const OVERLOADED = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.'

test('Claude terminal failures recognize authentication and overload batches', () => {
  assert.deepEqual(claudeTerminalFailureBatch(LOGIN), {
    key: 'auth',
    kinds: ['auth'],
    text: LOGIN,
  })
  assert.deepEqual(claudeTerminalFailureBatch(`${LOGIN}\n\n${LOGIN}\n\n${LOGIN}`), {
    key: 'auth',
    kinds: ['auth'],
    text: LOGIN,
  })
  assert.deepEqual(claudeTerminalFailureBatch(OVERLOADED), {
    key: 'overloaded',
    kinds: ['overloaded'],
    text: OVERLOADED,
  })
  assert.equal(claudeTerminalFailureBatch('The API was overloaded earlier, but the retry passed.'), null)
  assert.equal(claudeTerminalFailureBatch(`${LOGIN}\n\nAuthentication succeeded after the retry.`), null)
})

test('Claude poller finalizes an immediate terminal failure without ever seeing a spinner', () => {
  const auth = claudePollerDecision({ newAssistantText: LOGIN, sawSpinner: false, idleTicks: 0 })
  assert.equal(auth.action, 'failure')
  assert.equal(auth.failure.key, 'auth')

  const overload = claudePollerDecision({ newAssistantText: OVERLOADED, sawSpinner: false, idleTicks: 0 })
  assert.equal(overload.action, 'failure')
  assert.equal(overload.failure.key, 'overloaded')

  assert.deepEqual(claudePollerDecision({ newAssistantText: '', sawSpinner: false, idleTicks: 0 }), {
    action: 'wait', idleTicks: 0,
  })
})

test('Claude poller preserves spinner, form, and missing-Stop fallback behavior', () => {
  assert.deepEqual(claudePollerDecision({ spinner: true, sawSpinner: false, idleTicks: 2 }), {
    action: 'working', idleTicks: 0,
  })
  assert.deepEqual(claudePollerDecision({ hasForm: true, sawSpinner: true, idleTicks: 2 }), {
    action: 'form', idleTicks: 0,
  })
  assert.deepEqual(claudePollerDecision({ sawSpinner: true, idleTicks: 2 }), {
    action: 'wait', idleTicks: 3,
  })
  assert.deepEqual(claudePollerDecision({ sawSpinner: true, idleTicks: 3 }), {
    action: 'finalize', idleTicks: 4,
  })
  assert.deepEqual(claudePollerDecision({ sawSpinner: true, idleTicks: 3, pendingPermission: true }), {
    action: 'wait', idleTicks: 3,
  })
})

test('Claude terminal failure delivery is deduplicated for a bounded interval', () => {
  const now = 10_000
  const first = prepareClaudeTerminalDelivery(`${LOGIN}\n\n${LOGIN}`, null, now)
  assert.equal(first.text, LOGIN)
  assert.equal(first.suppress, false)
  assert.deepEqual(first.failure, { key: 'auth', at: now })

  const duplicate = prepareClaudeTerminalDelivery(LOGIN, first.failure, now + 1_000)
  assert.equal(duplicate.suppress, true)

  const later = prepareClaudeTerminalDelivery(LOGIN, first.failure, now + CLAUDE_FAILURE_DEDUPE_MS + 1)
  assert.equal(later.suppress, false)

  const recovery = prepareClaudeTerminalDelivery('Authentication restored.', first.failure, now + 2_000)
  assert.equal(recovery.suppress, false)
  assert.equal(recovery.failure, null)
})
