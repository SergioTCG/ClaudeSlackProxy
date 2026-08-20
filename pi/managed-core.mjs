export const MANAGED_STATE_VERSION = 1
export const MANAGED_POLICIES = Object.freeze(['auto', 'always', 'native'])

export const DEFAULT_MANAGED_BUDGETS = Object.freeze({
  maxMinutes: 120,
  maxParentTurns: 24,
  maxSubagents: 8,
  maxReviewCycles: 2,
})

const BUDGET_FLAGS = Object.freeze({
  minutes: { field: 'maxMinutes', min: 5, max: 1440 },
  turns: { field: 'maxParentTurns', min: 1, max: 100 },
  agents: { field: 'maxSubagents', min: 2, max: 32 },
  reviews: { field: 'maxReviewCycles', min: 1, max: 10 },
})

const SIMPLE_ACTIONS = new Set(['status', 'pause', 'continue', 'cancel', 'approve'])

function normalizeBudgets(value) {
  const budgets = { ...DEFAULT_MANAGED_BUDGETS }
  for (const spec of Object.values(BUDGET_FLAGS)) {
    const candidate = Number(value?.[spec.field])
    if (Number.isInteger(candidate) && candidate >= spec.min && candidate <= spec.max) {
      budgets[spec.field] = candidate
    }
  }
  budgets.maxReviewCycles = Math.min(budgets.maxReviewCycles, budgets.maxSubagents - 1)
  return budgets
}

export function parseManagedRunCommand(words) {
  const input = Array.isArray(words) ? words.map(String) : []
  if (!input.length) return { action: 'status' }
  const command = input[0].toLowerCase()
  if (command === 'mode') {
    if (input.length === 1) return { action: 'policy-status' }
    if (input.length === 2 && MANAGED_POLICIES.includes(input[1].toLowerCase())) {
      return { action: 'policy', policy: input[1].toLowerCase() }
    }
    return { error: 'Managed-run mode must be auto, always, or native.' }
  }
  if (command === 'direct') {
    const goal = input.slice(1).join(' ').trim()
    if (!goal) return { error: 'A direct Pi prompt is required.' }
    if (goal.length > 8000) return { error: 'The direct prompt is too long (maximum 8000 characters).' }
    return { action: 'direct', goal }
  }
  if (input.length === 1 && SIMPLE_ACTIONS.has(input[0].toLowerCase())) {
    return { action: input[0].toLowerCase() }
  }

  const budgets = {}
  const goalWords = []
  for (const word of input) {
    const flag = /^--(minutes|turns|agents|reviews)=(\d+)$/.exec(word)
    if (!flag) {
      if (/^--/.test(word)) return { error: `Unknown managed-run option: ${word}` }
      goalWords.push(word)
      continue
    }
    const spec = BUDGET_FLAGS[flag[1]]
    const value = Number(flag[2])
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      return { error: `${flag[1]} must be between ${spec.min} and ${spec.max}` }
    }
    budgets[spec.field] = value
  }

  let mode = 'auto'
  const first = String(goalWords[0] || '').toLowerCase()
  if (first === 'plan') { mode = 'plan'; goalWords.shift() }
  else if (first === 'start' || first === 'auto') goalWords.shift()
  else if (SIMPLE_ACTIONS.has(first)) {
    return { error: `Managed-run action ${first} does not accept a goal or budget options.` }
  }

  const goal = goalWords.join(' ').trim()
  if (!goal) return { error: 'A managed run needs a goal.' }
  if (goal.length > 8000) return { error: 'The managed-run goal is too long (maximum 8000 characters).' }
  const effective = { ...DEFAULT_MANAGED_BUDGETS, ...budgets }
  if (effective.maxSubagents < effective.maxReviewCycles + 1) {
    return { error: `agents must be at least reviews + 1 (${effective.maxReviewCycles + 1}) so planning and independent review both fit` }
  }
  return { action: 'start', mode, goal, budgets }
}

export function normalizeManagedPolicy(value, fallback = 'auto') {
  const policy = String(value || '').toLowerCase()
  return MANAGED_POLICIES.includes(policy) ? policy : fallback
}

export function parseManagedRoute(output) {
  const tagged = /^\s*<SAB_ROUTE_JSON>\s*([\s\S]*?)\s*<\/SAB_ROUTE_JSON>\s*$/i.exec(String(output || ''))
  let parsed = null
  if (tagged) {
    try { parsed = JSON.parse(tagged[1]) } catch {}
  }
  if (!['managed', 'native'].includes(parsed?.route)) {
    throw new Error('Router did not return a valid SAB_ROUTE_JSON decision.')
  }
  return {
    route: parsed.route,
    reason: cleanText(parsed.reason, 1000) || (parsed.route === 'managed' ? 'task benefits from managed orchestration' : 'task is suitable for native Pi'),
  }
}

const cleanText = (value, max = 1000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)

function normalizeSteps(values) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const steps = []
  for (const value of values) {
    const text = cleanText(typeof value === 'string' ? value : value?.text, 1000)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    steps.push({ id: steps.length + 1, text, status: 'pending' })
    if (steps.length >= 24) break
  }
  return steps
}

export function structuredChildSubmission(event) {
  if (event?.type !== 'tool_execution_end' || event?.isError) return null
  const details = event?.result?.details
  if (!details || !['plan', 'review'].includes(details.kind)) return null
  if (event.toolName !== `sab_submit_${details.kind}`) return null
  return details
}

export function parseManagedPlan(output, submission = null) {
  const text = String(output || '')
  let parsed = submission?.kind === 'plan' ? submission : null
  if (!parsed) {
    const tagged = /<SAB_PLAN_JSON>\s*([\s\S]*?)\s*<\/SAB_PLAN_JSON>/i.exec(text)
    if (tagged) {
      try { parsed = JSON.parse(tagged[1]) } catch {}
    }
    if (!parsed) {
      const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(text)
      if (fenced) {
        try { parsed = JSON.parse(fenced[1]) } catch {}
      }
    }
  }

  let steps = normalizeSteps(parsed?.steps)
  if (!steps.length) {
    steps = normalizeSteps([...text.matchAll(/^\s*\d+[.)]\s+(.+?)\s*$/gm)].map(match => match[1]))
  }
  if (steps.length < 2) throw new Error('Planner did not return a numbered plan with at least two steps.')

  return {
    summary: cleanText(parsed?.summary || parsed?.goal || '', 2000),
    steps,
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(value => cleanText(value, 1000)).filter(Boolean).slice(0, 12) : [],
  }
}

export function parseManagedReview(output, submission = null) {
  let parsed = submission?.kind === 'review' ? submission : null
  if (!parsed) {
    const tagged = /<SAB_REVIEW_JSON>\s*([\s\S]*?)\s*<\/SAB_REVIEW_JSON>/i.exec(String(output || ''))
    if (tagged) {
      try { parsed = JSON.parse(tagged[1]) } catch {}
    }
  }
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings.map(item => cleanText(item, 1500)).filter(Boolean).slice(0, 20)
    : []
  const verdict = parsed?.verdict === 'pass' ? 'pass' : parsed?.verdict === 'fix' ? 'fix' : null
  if (!verdict) throw new Error('Reviewer did not return a valid SAB_REVIEW_JSON verdict.')
  return { verdict, summary: cleanText(parsed?.summary, 4000), findings }
}

export function createManagedRun({ id, goal, mode = 'auto', budgets = {}, privateContext = '', now = Date.now() }) {
  const normalizedGoal = cleanText(goal, 8000)
  if (!normalizedGoal) throw new Error('Managed run goal is required.')
  return {
    version: MANAGED_STATE_VERSION,
    id: String(id || ''),
    goal: normalizedGoal,
    privateContext: String(privateContext || '').slice(0, 4000),
    mode: mode === 'plan' ? 'plan' : 'auto',
    status: 'active',
    phase: 'planning',
    plan: [],
    risks: [],
    summary: '',
    review: null,
    activeAgent: null,
    startedAt: Number(now),
    updatedAt: Number(now),
    budgets: normalizeBudgets(budgets),
    counters: {
      parentTurns: 0, subagents: 0, reviewCycles: 0, continuations: 0,
      parentTokens: 0, parentOutputTokens: 0, childTurns: 0,
      childTokens: 0, childOutputTokens: 0,
    },
    lastError: null,
  }
}

export function restoreManagedRun(value) {
  if (!value || typeof value !== 'object' || value.version !== MANAGED_STATE_VERSION) return null
  if (!String(value.id || '') || !cleanText(value.goal, 8000)) return null
  const run = createManagedRun({
    id: value.id,
    goal: value.goal,
    mode: value.mode,
    budgets: value.budgets,
    privateContext: value.privateContext,
    now: Number(value.startedAt) || Date.now(),
  })
  const statuses = new Set(['active', 'paused', 'complete', 'cancelled', 'failed'])
  const phases = new Set(['planning', 'awaiting-approval', 'executing', 'reviewing', 'fixing', 'finalizing', 'complete', 'paused', 'cancelled', 'failed'])
  run.status = statuses.has(value.status) ? value.status : 'paused'
  run.phase = phases.has(value.phase) ? value.phase : 'paused'
  run.plan = normalizeSteps(value.plan).map((step, index) => ({
    ...step,
    status: value.plan?.[index]?.status === 'done' ? 'done' : 'pending',
  }))
  run.risks = Array.isArray(value.risks) ? value.risks.map(item => cleanText(item, 1000)).filter(Boolean).slice(0, 12) : []
  run.summary = cleanText(value.summary, 4000)
  run.review = value.review && typeof value.review === 'object' ? value.review : null
  run.activeAgent = cleanText(value.activeAgent, 100) || null
  run.updatedAt = Number(value.updatedAt) || run.startedAt
  run.counters = {
    parentTurns: Math.max(0, Number(value.counters?.parentTurns) || 0),
    subagents: Math.max(0, Number(value.counters?.subagents) || 0),
    reviewCycles: Math.max(0, Number(value.counters?.reviewCycles) || 0),
    continuations: Math.max(0, Number(value.counters?.continuations) || 0),
    parentTokens: Math.max(0, Number(value.counters?.parentTokens) || 0),
    parentOutputTokens: Math.max(0, Number(value.counters?.parentOutputTokens) || 0),
    childTurns: Math.max(0, Number(value.counters?.childTurns) || 0),
    childTokens: Math.max(0, Number(value.counters?.childTokens) || 0),
    childOutputTokens: Math.max(0, Number(value.counters?.childOutputTokens) || 0),
  }
  run.resumePhase = typeof value.resumePhase === 'string' ? value.resumePhase.slice(0, 32) : null
  let stateError = ''
  const activePhases = new Set(['planning', 'executing', 'reviewing', 'fixing', 'finalizing'])
  if (run.status === 'active' && (!activePhases.has(run.phase) || (run.phase !== 'planning' && run.plan.length < 2))) {
    run.status = 'paused'
    run.phase = 'paused'
    run.resumePhase = null
    stateError = 'Persisted managed-run phase was inconsistent; continuation was paused safely.'
  } else if (run.status === 'paused' && run.phase === 'awaiting-approval' && run.plan.length < 2) {
    run.phase = 'paused'
    stateError = 'Persisted managed plan was incomplete; approval was disabled safely.'
  } else if (['complete', 'cancelled', 'failed'].includes(run.status)) {
    run.phase = run.status
  }
  run.lastError = stateError || cleanText(value.lastError, 1000) || null
  return run
}

export function markCompletedSteps(run, text) {
  if (!run?.plan?.length) return 0
  const ids = new Set([...String(text || '').matchAll(/\[DONE:(\d+)]/gi)].map(match => Number(match[1])))
  let changed = 0
  for (const step of run.plan) {
    if (ids.has(step.id) && step.status !== 'done') {
      step.status = 'done'
      changed++
    }
  }
  if (changed) run.updatedAt = Date.now()
  return changed
}

export function budgetExceeded(run, now = Date.now()) {
  if (!run?.budgets || !run?.counters) return 'managed-run state is invalid'
  const elapsed = Math.max(0, Number(now) - Number(run.startedAt || now))
  if (elapsed > Number(run.budgets.maxMinutes) * 60_000) return `time budget reached (${run.budgets.maxMinutes}m)`
  if (run.counters.parentTurns >= run.budgets.maxParentTurns) return `parent-turn budget reached (${run.budgets.maxParentTurns})`
  return null
}

export function subagentBudgetReason(run, role, required = false) {
  if (!run?.budgets || !run?.counters) return 'managed-run state is invalid'
  if (run.counters.subagents >= run.budgets.maxSubagents) return `subagent budget reached (${run.budgets.maxSubagents})`
  const reservedReviews = Math.max(1, run.budgets.maxReviewCycles - run.counters.reviewCycles)
  if (!(required && role === 'reviewer') && run.counters.subagents >= run.budgets.maxSubagents - reservedReviews) {
    return `subagent budget is reserved for ${reservedReviews} remaining independent review leg(s)`
  }
  return null
}

function formatElapsed(startedAt, now) {
  const seconds = Math.max(0, Math.floor((Number(now) - Number(startedAt)) / 1000))
  const minutes = Math.floor(seconds / 60)
  const s = seconds % 60
  const hours = Math.floor(minutes / 60)
  const m = minutes % 60
  return hours ? `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
    : `${m}m ${String(s).padStart(2, '0')}s`
}

export function managedSnapshot(run) {
  if (!run) return null
  const completedSteps = run.plan?.filter(step => step.status === 'done').length || 0
  const next = run.plan?.find(step => step.status !== 'done')
  return {
    id: run.id,
    goal: run.goal,
    mode: run.mode,
    status: run.status,
    phase: run.phase,
    currentStep: next?.id || (run.plan?.length || 0),
    totalSteps: run.plan?.length || 0,
    completedSteps,
    activeAgent: run.activeAgent || null,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    budgets: run.budgets,
    counters: run.counters,
    lastError: run.lastError || null,
  }
}

export function sanitizeManagedSnapshot(value) {
  if (!value || typeof value !== 'object' || !value.id || !value.goal) return null
  const number = input => Math.max(0, Number(input) || 0)
  return {
    id: String(value.id).slice(0, 100),
    goal: String(value.goal).slice(0, 8000),
    mode: value.mode === 'plan' ? 'plan' : 'auto',
    status: String(value.status || 'paused').slice(0, 32),
    phase: String(value.phase || 'paused').slice(0, 32),
    currentStep: number(value.currentStep),
    totalSteps: number(value.totalSteps),
    completedSteps: number(value.completedSteps),
    activeAgent: value.activeAgent ? String(value.activeAgent).slice(0, 100) : null,
    startedAt: number(value.startedAt),
    updatedAt: number(value.updatedAt),
    budgets: {
      maxMinutes: number(value.budgets?.maxMinutes),
      maxParentTurns: number(value.budgets?.maxParentTurns),
      maxSubagents: number(value.budgets?.maxSubagents),
      maxReviewCycles: number(value.budgets?.maxReviewCycles),
    },
    counters: {
      parentTurns: number(value.counters?.parentTurns),
      subagents: number(value.counters?.subagents),
      reviewCycles: number(value.counters?.reviewCycles),
      continuations: number(value.counters?.continuations),
      parentTokens: number(value.counters?.parentTokens),
      parentOutputTokens: number(value.counters?.parentOutputTokens),
      childTurns: number(value.counters?.childTurns),
      childTokens: number(value.counters?.childTokens),
      childOutputTokens: number(value.counters?.childOutputTokens),
    },
    lastError: value.lastError ? String(value.lastError).slice(0, 1000) : null,
  }
}

export function sanitizeRoutingSnapshot(value) {
  if (!value || typeof value !== 'object' || !value.id) return null
  return {
    id: String(value.id).slice(0, 100),
    status: ['routing', 'managed', 'native', 'cancelled'].includes(value.status) ? value.status : 'routing',
    policy: normalizeManagedPolicy(value.policy),
    source: value.source === 'terminal' ? 'terminal' : 'slack',
    startedAt: Math.max(0, Number(value.startedAt) || 0),
    reason: value.reason ? String(value.reason).slice(0, 1000) : null,
  }
}

export function formatManagedProgress(run, now = Date.now()) {
  const snapshot = managedSnapshot(run)
  if (!snapshot) return 'idle'
  const plan = snapshot.totalSteps
    ? ` · step ${snapshot.currentStep}/${snapshot.totalSteps} · ${snapshot.completedSteps}/${snapshot.totalSteps} done`
    : ''
  const agent = snapshot.activeAgent ? ` · ${snapshot.activeAgent}` : ''
  return `${snapshot.phase}${plan}${agent} · ${formatElapsed(snapshot.startedAt, now)}`
}
