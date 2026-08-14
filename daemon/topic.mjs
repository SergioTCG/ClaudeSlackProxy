// Slack announces every conversations.setTopic call, even when the value is
// unchanged. Hydrate the first value from Slack after daemon boot, then cache
// successful writes. Per-channel serialization prevents concurrent startup and
// SessionStart paths from racing into duplicate writes.
export function createTopicSync(web) {
  const known = new Map()
  const queues = new Map()

  return function syncTopic(channel, topic) {
    const desired = String(topic || '').slice(0, 250)
    const previous = queues.get(channel) || Promise.resolve()
    const queued = previous.catch(() => {}).then(async () => {
      if (known.get(channel) === desired) return false
      if (!known.has(channel)) {
        const info = await web.conversations.info({ channel })
        known.set(channel, String(info.channel?.topic?.value || ''))
        if (known.get(channel) === desired) return false
      }
      await web.conversations.setTopic({ channel, topic: desired })
      known.set(channel, desired)
      return true
    })
    queues.set(channel, queued)
    queued.finally(() => {
      if (queues.get(channel) === queued) queues.delete(channel)
    }).catch(() => {})
    return queued
  }
}
