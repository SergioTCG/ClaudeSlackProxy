// Lifecycle hooks are separate HTTP requests and can overlap. A new Codex turn
// commonly emits SessionStart and UserPromptSubmit together, so channel
// creation must be single-flight per in-memory session object.
export function createSessionChannelGate() {
  const pending = new WeakMap()
  return function ensureSessionChannel(session, createChannel) {
    if (session.channel) return Promise.resolve(session.channel)
    const existing = pending.get(session)
    if (existing) return existing
    const operation = Promise.resolve()
      .then(() => session.channel || createChannel())
      .finally(() => {
        if (pending.get(session) === operation) pending.delete(session)
      })
    pending.set(session, operation)
    return operation
  }
}

// session.channel is authoritative. Remove only aliases that point to a known
// session but disagree with that value; leave unknown legacy mappings for the
// normal cleanup/recovery paths rather than broadening boot-time mutation.
export function pruneSessionChannelAliases(state) {
  let pruned = 0
  for (const [channel, sid] of Object.entries(state?.channels || {})) {
    const session = state?.sessions?.[sid]
    if (!session || session.channel === channel) continue
    delete state.channels[channel]
    if (state.channelTmux) delete state.channelTmux[channel]
    pruned++
  }
  return pruned
}
