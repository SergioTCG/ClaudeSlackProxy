import path from 'node:path'

const TOKEN_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'reasoningOutputTokens',
  'cacheCreationTokens', 'cacheReadTokens', 'totalTokens',
])

export function usageRows(report, group) {
  const singular = report?.[group]
  if (Array.isArray(singular)) return singular
  const plural = report?.[`${group}s`]
  return Array.isArray(plural) ? plural : []
}

export const usageDate = row => String(row?.date || row?.period || '')
export const usageCost = row => row?.costUSD ?? row?.totalCost ?? null

export function codexSessionUsage(report, sessionId) {
  const sid = String(sessionId || '')
  if (!sid) return null
  return usageRows(report, 'session').find(row => {
    const value = String(row?.sessionId || row?.period || '')
    return value === sid || value.endsWith(`-${sid}`) || value.endsWith(`/${sid}`)
  }) || null
}

export function codexProjectUsage(report, sessions, cwd) {
  if (!cwd) return []
  const project = path.resolve(cwd)
  return Object.values(sessions || {})
    .filter(session => session?.provider === 'codex' && session.cwd && path.resolve(session.cwd) === project)
    .map(session => codexSessionUsage(report, session.id))
    .filter(Boolean)
}

export function codexTokenSnapshot(row) {
  if (!row) return null
  return Object.fromEntries(TOKEN_FIELDS.map(field => [
    field, Number.isFinite(Number(row[field])) ? Number(row[field]) : 0,
  ]))
}

export function codexTurnTokenDelta(current, baseline) {
  const now = codexTokenSnapshot(current)
  const before = codexTokenSnapshot(baseline)
  if (!now || !before) return null
  return Object.fromEntries(TOKEN_FIELDS.map(field => [field, Math.max(0, now[field] - before[field])]))
}

export const formatTokens = n => n == null ? '—'
  : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
    : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
      : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k'
        : String(Math.round(n))

export function formatElapsed(startedAt, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Number(startedAt || 0)) / 1000))
  const s = seconds % 60
  const minutes = Math.floor(seconds / 60)
  if (!minutes) return `${s}s`
  const m = minutes % 60
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
    : `${m}m ${String(s).padStart(2, '0')}s`
}

export function formatCodexWorkingStatus({ startedAt, now = Date.now(), baseline, current }) {
  const parts = [formatElapsed(startedAt, now)]
  const delta = codexTurnTokenDelta(current, baseline)
  if (delta?.totalTokens > 0) {
    parts.push(`${formatTokens(delta.totalTokens)} tokens this turn`)
    if (delta.outputTokens > 0) parts.push(`↓ ${formatTokens(delta.outputTokens)} out`)
    if (delta.reasoningOutputTokens > 0) parts.push(`${formatTokens(delta.reasoningOutputTokens)} reasoning`)
  }
  return `⚙️ Codex is working… (${parts.join(' · ')})`
}

export function normalizePiUsage(usage, contextUsage = null) {
  if (!usage && !contextUsage) return null
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
  return {
    inputTokens: number(usage?.input),
    outputTokens: number(usage?.output),
    cacheReadTokens: number(usage?.cacheRead),
    cacheWriteTokens: number(usage?.cacheWrite),
    totalTokens: number(usage?.totalTokens ?? usage?.total),
    cost: number(usage?.cost?.total ?? usage?.cost),
    contextTokens: number(contextUsage?.tokens),
    contextWindow: number(contextUsage?.contextWindow),
    contextPercent: number(contextUsage?.percent),
  }
}

export function formatPiWorkingStatus({ startedAt, now = Date.now(), usage }) {
  const parts = [formatElapsed(startedAt, now)]
  if (usage?.totalTokens > 0) parts.push(`${formatTokens(usage.totalTokens)} tokens this turn`)
  if (usage?.outputTokens > 0) parts.push(`↓ ${formatTokens(usage.outputTokens)} out`)
  if (usage?.contextPercent > 0) parts.push(`context ${Math.round(usage.contextPercent)}%`)
  return `⚙️ Pi is working… (${parts.join(' · ')})`
}

export function piUsageRows(rows, { sessionId, cwd, since, model } = {}) {
  return (Array.isArray(rows) ? rows : []).filter(row => {
    if (sessionId && row?.sessionId !== sessionId) return false
    if (cwd && (!row?.cwd || path.resolve(row.cwd) !== path.resolve(cwd))) return false
    if (since && Number(row?.at || 0) < Number(since)) return false
    if (model && row?.model !== model) return false
    return true
  })
}
