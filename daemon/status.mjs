// Slack message timestamps are immutable, so editing a working-status message
// cannot move it below newer channel activity. This owner serializes all status
// mutations per session and can transactionally replace the message when it
// needs to become the newest item again.

const isNewerOrEqual = (left, right) => {
  const a = Number(left)
  const b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) && a >= b
}

export function createStatusMessages(web, {
  log = () => {},
  postMessage = (channel, text) => web.chat.postMessage({ channel, text }),
} = {}) {
  const entries = new Map()

  const entryFor = sid => {
    let entry = entries.get(sid)
    if (!entry) {
      entry = { ts: null, text: '', queue: Promise.resolve() }
      entries.set(sid, entry)
    }
    return entry
  }

  const serialize = (sid, action) => {
    const entry = entryFor(sid)
    const queued = entry.queue.catch(() => {}).then(() => action(entry))
    entry.queue = queued
    return queued
  }

  async function set(session, text) {
    if (!session?.id || !session.channel) return false
    const desiredText = String(text || '')
    return serialize(session.id, async current => {
      current.text = desiredText
      try {
        if (current.ts) {
          await web.chat.update({ channel: session.channel, ts: current.ts, text: current.text })
        } else {
          const posted = await postMessage(session.channel, current.text)
          current.ts = posted.ts
        }
        return true
      } catch (error) {
        if (error?.data?.error === 'message_not_found') current.ts = null
        else log('setStatus error:', error?.data?.error || String(error))
        return false
      }
    })
  }

  async function bump(session, { afterTs = null } = {}) {
    if (!session?.id || !session.channel) return false
    return serialize(session.id, async current => {
      const oldTs = current.ts
      if (!oldTs || !current.text) return false
      if (afterTs && isNewerOrEqual(oldTs, afterTs)) return false

      let replacement
      try {
        replacement = await postMessage(session.channel, current.text)
        if (!replacement?.ts) throw new Error('Slack did not return a status timestamp')
      } catch (error) {
        log('bumpStatus post error:', error?.data?.error || String(error))
        return false
      }

      try {
        await web.chat.delete({ channel: session.channel, ts: oldTs })
      } catch (error) {
        if (error?.data?.error !== 'message_not_found') {
          // Keep the old authoritative status if replacement could not be made
          // atomic. Best-effort cleanup avoids leaving two live status lines.
          try { await web.chat.delete({ channel: session.channel, ts: replacement.ts }) } catch {}
          log('bumpStatus delete error:', error?.data?.error || String(error))
          return false
        }
      }
      current.ts = replacement.ts
      return true
    })
  }

  async function clear(session) {
    if (!session?.id) return false
    return serialize(session.id, async current => {
      const ts = current.ts
      current.ts = null
      current.text = ''
      if (!session.channel || !ts) return false
      try { await web.chat.delete({ channel: session.channel, ts }) } catch {}
      return true
    })
  }

  function adopt(sid, ts) {
    if (!sid || !ts) return
    entryFor(sid).ts = ts
  }

  return { set, bump, clear, adopt }
}
