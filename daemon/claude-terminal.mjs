// Claude can terminate a turn before its spinner is observable and without
// emitting Stop. Keep the pane/transcript failure grammar in this adapter so
// the shared daemon lifecycle does not accumulate provider-specific checks.

export const CLAUDE_FAILURE_DEDUPE_MS = 5 * 60_000

const clean = value => String(value || '').replace(/\s+/g, ' ').trim()

function classifyFailureParagraph(value) {
  const text = clean(value)
  if (/^Login expired\s*[·•]\s*Please run\s+\/login\.?$/i.test(text)) {
    return { kind: 'auth', text }
  }
  if (/^API Error:\s*529\s+Overloaded\b.*$/i.test(text) ||
      /^(?:Claude(?: Code)?|Anthropic(?: API)?)\s+is\s+(?:currently\s+)?overloaded\b.*$/i.test(text)) {
    return { kind: 'overloaded', text }
  }
  return null
}

// Only classify a whole failure-only batch. An ordinary answer may discuss or
// quote these errors; treating a substring match as terminal would truncate a
// legitimate response before its normal Stop hook arrives.
export function claudeTerminalFailureBatch(value) {
  const paragraphs = String(value || '').trim().split(/\n\s*\n/).map(clean).filter(Boolean)
  if (!paragraphs.length) return null
  const failures = paragraphs.map(classifyFailureParagraph)
  if (failures.some(value => !value)) return null

  const unique = []
  const seen = new Set()
  for (const failure of failures) {
    if (seen.has(failure.kind)) continue
    seen.add(failure.kind)
    unique.push(failure)
  }
  return {
    key: unique.map(failure => failure.kind).join('|'),
    kinds: unique.map(failure => failure.kind),
    text: unique.map(failure => failure.text).join('\n\n'),
  }
}

export function claudePollerDecision({
  spinner = false,
  newAssistantText = '',
  hasForm = false,
  sawSpinner = false,
  idleTicks = 0,
  pendingPermission = false,
} = {}) {
  if (spinner) return { action: 'working', idleTicks: 0 }

  const failure = claudeTerminalFailureBatch(newAssistantText)
  if (failure) return { action: 'failure', idleTicks, failure }
  if (hasForm) return { action: 'form', idleTicks: 0 }

  if (sawSpinner && !pendingPermission) {
    const nextIdle = idleTicks + 1
    return { action: nextIdle >= 4 ? 'finalize' : 'wait', idleTicks: nextIdle }
  }
  return { action: 'wait', idleTicks }
}

export function prepareClaudeTerminalDelivery(text, previousFailure = null, now = Date.now()) {
  const raw = String(text || '').trim()
  const batch = claudeTerminalFailureBatch(raw)
  if (!batch) return { text: raw, suppress: false, failure: null }

  const failure = { key: batch.key, at: now }
  const suppress = previousFailure?.key === batch.key &&
    now - Number(previousFailure?.at || 0) < CLAUDE_FAILURE_DEDUPE_MS
  return { text: batch.text, suppress, failure }
}
