import test from 'node:test'
import assert from 'node:assert/strict'
import {
  budgetExceeded, createManagedRun, formatManagedProgress, managedSnapshot, markCompletedSteps,
  normalizeManagedPolicy, parseManagedPlan, parseManagedReview, parseManagedRoute,
  parseManagedRunCommand, restoreManagedRun, sanitizeManagedSnapshot,
  sanitizeRoutingSnapshot, subagentBudgetReason,
} from '../pi/managed-core.mjs'

test('managed Pi command defaults to an automatic run and accepts bounded budgets', () => {
  assert.deepEqual(parseManagedRunCommand([]), { action: 'status' })
  assert.deepEqual(parseManagedRunCommand(['status']), { action: 'status' })
  assert.deepEqual(parseManagedRunCommand(['pause']), { action: 'pause' })
  assert.deepEqual(parseManagedRunCommand(['continue']), { action: 'continue' })
  assert.deepEqual(parseManagedRunCommand(['cancel']), { action: 'cancel' })
  assert.deepEqual(parseManagedRunCommand(['approve']), { action: 'approve' })

  assert.deepEqual(parseManagedRunCommand([
    '--minutes=90', '--turns=12', '--agents=4', '--reviews=3',
    'Implement', 'the', 'feature',
  ]), {
    action: 'start', mode: 'auto', goal: 'Implement the feature',
    budgets: { maxMinutes: 90, maxParentTurns: 12, maxSubagents: 4, maxReviewCycles: 3 },
  })
  assert.deepEqual(parseManagedRunCommand(['plan', 'Investigate', 'safely']), {
    action: 'start', mode: 'plan', goal: 'Investigate safely', budgets: {},
  })
  assert.match(parseManagedRunCommand(['--turns=0', 'bad']).error, /turns/i)
  assert.match(parseManagedRunCommand(['--reviews=0', 'bad']).error, /reviews/i)
  assert.match(parseManagedRunCommand(['--agents=2', 'bad']).error, /agents.*reviews/i)
  assert.match(parseManagedRunCommand(['start']).error, /goal/i)
  assert.deepEqual(parseManagedRunCommand(['mode']), { action: 'policy-status' })
  assert.deepEqual(parseManagedRunCommand(['mode', 'always']), { action: 'policy', policy: 'always' })
  assert.deepEqual(parseManagedRunCommand(['direct', 'answer', 'briefly']), { action: 'direct', goal: 'answer briefly' })
  assert.match(parseManagedRunCommand(['mode', 'sometimes']).error, /auto.*always.*native/i)
})

test('adaptive routing is strict, bounded, and defaults to auto', () => {
  assert.equal(normalizeManagedPolicy('ALWAYS'), 'always')
  assert.equal(normalizeManagedPolicy('unknown'), 'auto')
  assert.deepEqual(parseManagedRoute('<SAB_ROUTE_JSON>{"route":"managed","reason":"multiple files and validation"}</SAB_ROUTE_JSON>'), {
    route: 'managed', reason: 'multiple files and validation',
  })
  assert.throws(() => parseManagedRoute('probably native'), /valid.*decision/i)
  assert.throws(() => parseManagedRoute('preface\n<SAB_ROUTE_JSON>{"route":"native"}</SAB_ROUTE_JSON>'), /valid.*decision/i)
  assert.deepEqual(sanitizeRoutingSnapshot({
    id: 'route-1', status: 'managed', policy: 'auto', source: 'terminal', startedAt: 1000,
    reason: 'r'.repeat(2000), privateContext: 'secret', files: ['/tmp/no'],
  }), {
    id: 'route-1', status: 'managed', policy: 'auto', source: 'terminal', startedAt: 1000,
    reason: 'r'.repeat(1000),
  })
})

test('managed plans prefer tagged JSON and fall back to numbered text', () => {
  assert.deepEqual(parseManagedPlan(`analysis\n<SAB_PLAN_JSON>{"summary":"Do it","steps":["Inspect code",{"text":"Add tests"}],"risks":["compat"]}</SAB_PLAN_JSON>`), {
    summary: 'Do it',
    steps: [
      { id: 1, text: 'Inspect code', status: 'pending' },
      { id: 2, text: 'Add tests', status: 'pending' },
    ],
    risks: ['compat'],
  })
  assert.deepEqual(parseManagedPlan('Plan:\n1. Read the code\n2) Add regression tests').steps.map(step => step.text), [
    'Read the code', 'Add regression tests',
  ])
  assert.throws(() => parseManagedPlan('No actionable steps.'), /numbered plan/i)
  assert.throws(() => parseManagedPlan('1. Only one step'), /at least two steps/i)
})

test('managed run progress is persistent, marker-driven, and budgeted', () => {
  const run = createManagedRun({
    id: 'run-1', goal: 'Ship it', mode: 'auto', now: 1_000,
    privateContext: 'private capability',
    budgets: { maxMinutes: 10, maxParentTurns: 3, maxSubagents: 2, maxReviewCycles: 1 },
  })
  run.phase = 'executing'
  run.plan = parseManagedPlan('1. Inspect\n2. Implement\n3. Verify').steps
  assert.equal(markCompletedSteps(run, 'Finished [DONE:1] and [DONE:2].'), 2)
  assert.equal(markCompletedSteps(run, 'Again [DONE:2].'), 0)
  assert.deepEqual(run.plan.map(step => step.status), ['done', 'done', 'pending'])
  assert.equal(formatManagedProgress(run, 61_000), 'executing · step 3/3 · 2/3 done · 1m 00s')

  run.counters.parentTurns = 3
  assert.match(budgetExceeded(run, 61_000), /parent-turn budget/i)
  run.counters.parentTurns = 1
  assert.equal(budgetExceeded(run, 601_001), 'time budget reached (10m)')

  const restored = restoreManagedRun(JSON.parse(JSON.stringify(run)))
  assert.equal(restored.id, 'run-1')
  assert.equal(restored.plan[2].status, 'pending')
  assert.equal(restored.privateContext, 'private capability')
  assert.equal('privateContext' in managedSnapshot(run), false)
})

test('invalid persisted managed state fails closed instead of auto-continuing', () => {
  assert.equal(restoreManagedRun(null), null)
  assert.equal(restoreManagedRun({ version: 99, status: 'active' }), null)
  assert.equal(restoreManagedRun({ version: 1, id: 'x', goal: '', status: 'active' }), null)
  const restored = restoreManagedRun({
    version: 1, id: 'x', goal: 'safe', status: 'paused', phase: 'paused',
    budgets: { maxMinutes: 999999, maxParentTurns: -1, maxSubagents: 1, maxReviewCycles: 0 },
  })
  assert.deepEqual(restored.budgets, { maxMinutes: 120, maxParentTurns: 24, maxSubagents: 8, maxReviewCycles: 2 })
  const inconsistent = restoreManagedRun({ version: 1, id: 'y', goal: 'safe', status: 'active', phase: 'complete' })
  assert.equal(inconsistent.status, 'paused')
  assert.match(inconsistent.lastError, /inconsistent/i)
})

test('managed review parsing fails closed and caps findings', () => {
  assert.deepEqual(parseManagedReview('<SAB_REVIEW_JSON>{"verdict":"pass","summary":"Clean","findings":[]}</SAB_REVIEW_JSON>'), {
    verdict: 'pass', summary: 'Clean', findings: [],
  })
  assert.deepEqual(parseManagedReview('<SAB_REVIEW_JSON>{"verdict":"fix","summary":"Fix it","findings":["a.js:1 - bug"]}</SAB_REVIEW_JSON>').verdict, 'fix')
  assert.throws(() => parseManagedReview('Looks fine to me.'), /valid.*verdict/i)
})

test('optional subagents cannot consume slots reserved for independent review', () => {
  const run = createManagedRun({ id: 'run-2', goal: 'Test', budgets: { maxSubagents: 4, maxReviewCycles: 2 } })
  run.counters.subagents = 2
  assert.match(subagentBudgetReason(run, 'scout'), /reserved/i)
  assert.match(subagentBudgetReason(run, 'planner'), /reserved/i)
  assert.match(subagentBudgetReason(run, 'reviewer'), /reserved/i)
  assert.equal(subagentBudgetReason(run, 'reviewer', true), null)
  run.counters.subagents = 4
  assert.match(subagentBudgetReason(run, 'reviewer'), /budget reached/i)
})

test('daemon managed snapshots retain only bounded scalar state', () => {
  const snapshot = sanitizeManagedSnapshot({
    id: 'x'.repeat(200), goal: 'g'.repeat(9000), mode: 'plan', status: 'active', phase: 'executing',
    currentStep: -4, totalSteps: '8', completedSteps: 2, activeAgent: 'worker',
    startedAt: 1000, updatedAt: 2000,
    budgets: { maxMinutes: 10, maxParentTurns: 3, maxSubagents: 4, maxReviewCycles: 1, injected: { huge: true } },
    counters: { parentTurns: 1, subagents: 2, reviewCycles: 0, continuations: 1, injected: ['no'] },
    lastError: 'e'.repeat(2000), extra: { ignored: true },
  })
  assert.equal(snapshot.id.length, 100)
  assert.equal(snapshot.goal.length, 8000)
  assert.equal(snapshot.currentStep, 0)
  assert.deepEqual(Object.keys(snapshot.budgets).sort(), ['maxMinutes', 'maxParentTurns', 'maxReviewCycles', 'maxSubagents'])
  assert.equal(snapshot.lastError.length, 1000)
  assert.equal('extra' in snapshot, false)
})
