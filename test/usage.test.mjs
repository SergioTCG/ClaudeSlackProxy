import test from 'node:test'
import assert from 'node:assert/strict'
import {
  codexProjectUsage, codexSessionUsage, codexTokenSnapshot, codexTurnTokenDelta,
  formatCodexWorkingStatus, formatPiWorkingStatus, formatTokens, normalizePiUsage,
  piUsageRows, usageCost, usageDate, usageRows,
} from '../daemon/usage.mjs'

const sid = '019fff4d-9217-7ee1-825d-528aec50a0e9'
const baseline = {
  inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 8,
  cacheCreationTokens: 0, cacheReadTokens: 1000, totalTokens: 1120,
}
const current = {
  inputTokens: 160, outputTokens: 45, reasoningOutputTokens: 18,
  cacheCreationTokens: 0, cacheReadTokens: 1300, totalTokens: 1505,
}

test('Codex session usage matches ccusage path-prefixed session ids', () => {
  const row = { sessionId: `2026/08/14/rollout-${sid}`, ...current }
  assert.equal(codexSessionUsage({ sessions: [row] }, sid), row)
  assert.equal(codexSessionUsage({ sessions: [{ sessionId: 'another' }] }, sid), null)
})

test('Codex project usage joins ccusage ids through bridge cwd state', () => {
  const other = '019fff62-e79e-7ca0-83ff-d53d8a8cd302'
  const report = { sessions: [
    { sessionId: `rollout-${sid}`, totalTokens: 1 },
    { sessionId: `rollout-${other}`, totalTokens: 2 },
  ] }
  const sessions = {
    [sid]: { id: sid, provider: 'codex', cwd: '/repo' },
    [other]: { id: other, provider: 'codex', cwd: '/other' },
    claude: { id: 'claude', cwd: '/repo' },
  }
  assert.deepEqual(codexProjectUsage(report, sessions, '/repo').map(row => row.totalTokens), [1])
})

test('Codex turn token deltas are clamped and retain useful breakdowns', () => {
  assert.deepEqual(codexTokenSnapshot(current), current)
  assert.deepEqual(codexTokenSnapshot({}), {
    inputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0,
  })
  assert.deepEqual(codexTurnTokenDelta(current, baseline), {
    inputTokens: 60, outputTokens: 25, reasoningOutputTokens: 10,
    cacheCreationTokens: 0, cacheReadTokens: 300, totalTokens: 385,
  })
  assert.equal(codexTurnTokenDelta({ ...baseline, totalTokens: 900 }, baseline).totalTokens, 0)
})

test('Codex working status includes elapsed time and per-turn tokens', () => {
  assert.equal(formatCodexWorkingStatus({ startedAt: 0, now: 129000, baseline, current }),
    '⚙️ Codex is working… (2m 09s · 385 tokens this turn · ↓ 25 out · 10 reasoning)')
  assert.equal(formatCodexWorkingStatus({ startedAt: 0, now: 9000, baseline, current: baseline }),
    '⚙️ Codex is working… (9s)')
})

test('provider usage schema helpers accept Claude and Codex ccusage JSON', () => {
  assert.deepEqual(usageRows({ session: [1] }, 'session'), [1])
  assert.deepEqual(usageRows({ sessions: [2] }, 'session'), [2])
  assert.equal(usageDate({ period: '2026-08-14' }), '2026-08-14')
  assert.equal(usageDate({ date: '2026-08-15' }), '2026-08-15')
  assert.equal(usageCost({ totalCost: 1.25 }), 1.25)
  assert.equal(usageCost({ costUSD: 2.5 }), 2.5)
  assert.equal(formatTokens(12_345), '12.3k')
})

test('Pi usage normalization retains tokens, context, and zero-cost local models', () => {
  assert.deepEqual(normalizePiUsage({
    input: 1200, output: 300, cacheRead: 50, cacheWrite: 25, totalTokens: 1575,
    cost: { total: 0 },
  }, { tokens: 4000, contextWindow: 131072, percent: 3.05 }), {
    inputTokens: 1200, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 25,
    totalTokens: 1575, cost: 0, contextTokens: 4000, contextWindow: 131072, contextPercent: 3.05,
  })
})

test('Pi working status includes elapsed time and live token counts', () => {
  assert.equal(formatPiWorkingStatus({
    startedAt: 0, now: 65000,
    usage: { totalTokens: 1575, outputTokens: 300, contextPercent: 3.05 },
  }), '⚙️ Pi is working… (1m 05s · 1.6k tokens this turn · ↓ 300 out · context 3%)')
})

test('Pi working status includes managed phase and plan progress', () => {
  assert.equal(formatPiWorkingStatus({
    startedAt: 0, now: 65_000,
    usage: { totalTokens: 1_575, outputTokens: 300, contextPercent: 3.05 },
    managed: {
      phase: 'executing', currentStep: 3, totalSteps: 8, completedSteps: 2, activeAgent: 'worker',
      counters: { parentTokens: 1_000, parentOutputTokens: 200, childTokens: 500, childOutputTokens: 100 },
    },
  }), '⚙️ Pi managed run — executing step 3/8 · worker (1m 05s · 3.1k tokens managed · ↓ 600 out · context 3%)')
})

test('Pi adaptive routing has a distinct live status', () => {
  const text = formatPiWorkingStatus({
    startedAt: 1_000, now: 6_000, usage: null,
    routing: { status: 'routing', startedAt: 1_000 },
  })
  assert.match(text, /assessing task complexity/i)
  assert.match(text, /5s/)
})

test('Pi usage ledger can filter by session, project, day, and model', () => {
  const rows = [
    { at: Date.parse('2026-08-18T10:00:00Z'), sessionId: 'a', cwd: '/repo', model: 'local/a', totalTokens: 100 },
    { at: Date.parse('2026-08-19T10:00:00Z'), sessionId: 'b', cwd: '/repo', model: 'local/b', totalTokens: 200 },
    { at: Date.parse('2026-08-19T11:00:00Z'), sessionId: 'c', cwd: '/other', model: 'local/a', totalTokens: 300 },
  ]
  assert.deepEqual(piUsageRows(rows, { sessionId: 'b' }).map(row => row.totalTokens), [200])
  assert.deepEqual(piUsageRows(rows, { cwd: '/repo' }).map(row => row.totalTokens), [100, 200])
  assert.deepEqual(piUsageRows(rows, { since: Date.parse('2026-08-19T00:00:00Z') }).map(row => row.totalTokens), [200, 300])
  assert.deepEqual(piUsageRows(rows, { model: 'local/a' }).map(row => row.totalTokens), [100, 300])
})
