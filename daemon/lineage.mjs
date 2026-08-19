import crypto from 'node:crypto'
import { PROVIDERS, providerOf } from './providers.mjs'

export const LINEAGE_VERSION = 2
export const TRANSITION_PHASES = Object.freeze([
  'preflight', 'aligning', 'handoff', 'handoff_ready',
  'target_starting', 'target_validating', 'committing', 'rolling_back',
])

const phaseSet = new Set(TRANSITION_PHASES)

export function defaultSwitchTarget(provider) {
  if (provider === 'claude') return 'codex'
  if (provider === 'codex') return 'claude'
  return null
}

function upgradeLineage(lineage) {
  if (!lineage) return lineage
  if (!lineage.legs) lineage.legs = {}
  for (const provider of PROVIDERS) if (!(provider in lineage.legs)) lineage.legs[provider] = null
  lineage.version = LINEAGE_VERSION
  return lineage
}

export function lineageFor(state, channel) {
  return state?.lineages?.[channel] || null
}

// Lineages are created only when a channel first switches provider. Merely
// loading an old state file must never rewrite every legacy Claude session.
export function ensureLineage(state, channel, activeSession) {
  if (!state.lineages) state.lineages = {}
  if (state.lineages[channel]) return upgradeLineage(state.lineages[channel])
  if (!activeSession?.id || state.channels?.[channel] !== activeSession.id) {
    throw new Error('cannot create a lineage without the channel active session')
  }
  const provider = providerOf(activeSession)
  const lineage = {
    version: LINEAGE_VERSION,
    generation: 0,
    activeProvider: provider,
    legs: Object.fromEntries(PROVIDERS.map(name => [name, name === provider ? activeSession.id : null])),
    transition: null,
  }
  state.lineages[channel] = lineage
  return lineage
}

export function beginTransition(state, channel, activeSession, {
  now = Date.now(), id = crypto.randomUUID(), targetFlags = [], targetKind = 'new', targetProvider = null,
} = {}) {
  const lineage = ensureLineage(state, channel, activeSession)
  if (lineage.transition) throw new Error('provider switch already in progress')
  const sourceProvider = providerOf(activeSession)
  if (lineage.activeProvider !== sourceProvider || lineage.legs[sourceProvider] !== activeSession.id) {
    throw new Error('lineage active leg does not match the channel session')
  }
  targetProvider ||= defaultSwitchTarget(sourceProvider)
  if (!PROVIDERS.includes(targetProvider)) throw new Error('provider switch target is required')
  if (targetProvider === sourceProvider) throw new Error('target provider is already the active provider')
  const transition = {
    id,
    phase: 'preflight',
    createdAt: now,
    updatedAt: now,
    source: {
      provider: sourceProvider,
      sid: activeSession.id,
      pid: activeSession.pid || null,
      tmux: activeSession.tmux || null,
    },
    target: {
      provider: targetProvider,
      sid: lineage.legs[targetProvider] || null,
      tmux: null,
      kind: lineage.legs[targetProvider] ? 'resume' : targetKind,
      effectiveFlags: [...targetFlags],
    },
    instructions: null,
    handoff: null,
    queued: [],
    error: null,
  }
  lineage.transition = transition
  return transition
}

export function setTransitionPhase(lineage, phase, patch = {}, now = Date.now()) {
  if (!lineage?.transition) throw new Error('no provider switch in progress')
  if (!phaseSet.has(phase)) throw new Error(`invalid provider switch phase: ${phase}`)
  Object.assign(lineage.transition, patch)
  lineage.transition.phase = phase
  lineage.transition.updatedAt = now
  return lineage.transition
}

export function transitionMatchesTarget(lineage, provider, tmux) {
  const transition = lineage?.transition
  if (!transition || !['target_starting', 'target_validating'].includes(transition.phase)) return false
  return transition.target.provider === provider && Boolean(tmux) && transition.target.tmux === tmux
}

export function transitionForTarget(state, provider, tmux) {
  for (const [channel, lineage] of Object.entries(state?.lineages || {})) {
    if (transitionMatchesTarget(lineage, provider, tmux)) return { channel, lineage, transition: lineage.transition }
  }
  return null
}

export function transitionForSession(state, sid) {
  for (const [channel, lineage] of Object.entries(state?.lineages || {})) {
    const transition = lineage.transition
    if (transition && (transition.source.sid === sid || transition.target.sid === sid)) {
      return { channel, lineage, transition }
    }
  }
  return null
}

export function standbyForSession(state, sid) {
  for (const [channel, lineage] of Object.entries(state?.lineages || {})) {
    for (const provider of PROVIDERS) {
      if (lineage.legs?.[provider] === sid && lineage.activeProvider !== provider) {
        return { channel, lineage, provider }
      }
    }
  }
  return null
}

export function commitTransition(state, channel, targetSession, now = Date.now()) {
  const lineage = lineageFor(state, channel)
  const transition = lineage?.transition
  if (!transition || transition.target.sid !== targetSession?.id) {
    throw new Error('target session does not match the provider switch')
  }
  if (providerOf(targetSession) !== transition.target.provider) {
    throw new Error('target provider does not match the provider switch')
  }
  const source = state.sessions[transition.source.sid]
  if (source) source.channel = null
  targetSession.channel = channel
  state.channels[channel] = targetSession.id
  lineage.legs[transition.source.provider] = transition.source.sid
  lineage.legs[transition.target.provider] = targetSession.id
  lineage.activeProvider = transition.target.provider
  lineage.generation += 1
  lineage.lastSwitchAt = now
  lineage.pendingDelivery = [...(lineage.pendingDelivery || []), ...(transition.queued || [])]
  lineage.transition = null
  return lineage
}

export function rollbackTransition(state, channel, reason = null, now = Date.now()) {
  const lineage = lineageFor(state, channel)
  const transition = lineage?.transition
  if (!transition) return null
  const source = state.sessions[transition.source.sid]
  const target = transition.target.sid ? state.sessions[transition.target.sid] : null
  if (source) {
    source.channel = channel
    state.channels[channel] = source.id
  }
  if (target && target.id !== source?.id) target.channel = null
  lineage.activeProvider = transition.source.provider
  lineage.legs[transition.source.provider] = transition.source.sid
  if (transition.target.sid) lineage.legs[transition.target.provider] = transition.target.sid
  lineage.lastFailure = reason ? { at: now, reason: String(reason).slice(0, 500) } : null
  lineage.pendingDelivery = [...(lineage.pendingDelivery || []), ...(transition.queued || [])]
  lineage.transition = null
  return source || null
}

export function enqueueTransitionItem(transition, item, limit = 50) {
  if (!transition) throw new Error('no provider switch in progress')
  if (!Array.isArray(transition.queued)) transition.queued = []
  if (transition.queued.length >= limit) throw new Error('provider switch queue is full')
  transition.queued.push(item)
  return transition.queued.length
}

export function lineageSessionIds(lineage) {
  return [...new Set(PROVIDERS.map(provider => lineage?.legs?.[provider]).filter(Boolean))]
}

export function deleteLineage(state, channel) {
  const lineage = lineageFor(state, channel)
  const ids = lineageSessionIds(lineage)
  if (!ids.length && state.channels?.[channel]) ids.push(state.channels[channel])
  for (const sid of ids) delete state.sessions[sid]
  delete state.channels[channel]
  if (state.lineages) delete state.lineages[channel]
  if (state.channelTmux) delete state.channelTmux[channel]
  if (state.whitelist) delete state.whitelist[channel]
  return ids
}

export function rebindLineageSession(state, oldSid, newSid, provider) {
  for (const lineage of Object.values(state?.lineages || {})) {
    if (lineage.legs?.[provider] === oldSid) lineage.legs[provider] = newSid
    const transition = lineage.transition
    if (transition?.source?.sid === oldSid) transition.source.sid = newSid
    if (transition?.target?.sid === oldSid) transition.target.sid = newSid
  }
}

// Daemon restart recovery is deliberately conservative. A pre-target phase can
// simply be abandoned. Once a provisional target exists, its exact tmux is
// returned to the caller for reaping before the source mapping is restored.
export function recoveryDecision(transition, { targetTmuxAlive = false } = {}) {
  if (!transition) return { action: 'none' }
  if (['preflight', 'aligning', 'handoff', 'handoff_ready'].includes(transition.phase)) {
    return { action: 'rollback', killTargetTmux: false }
  }
  return {
    action: 'rollback',
    killTargetTmux: Boolean(transition.target?.tmux && targetTmuxAlive),
    targetTmux: transition.target?.tmux || null,
  }
}
