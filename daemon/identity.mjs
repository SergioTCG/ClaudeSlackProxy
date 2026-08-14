export const PRODUCT_NAME = 'Slack Agent Bridge'
export const REPOSITORY_SLUG = 'SlackAgentBridge'

// Public names can change without invalidating installed state. A fresh 1.0
// install uses the neutral name; an upgrade reuses either existing channel.
export const CONTROL_CHANNEL_NAME = 'slack-agent-bridge'
export const LEGACY_CONTROL_CHANNEL_NAMES = Object.freeze(['claude-code-bridge'])
export const CONTROL_CHANNEL_NAMES = Object.freeze([
  CONTROL_CHANNEL_NAME,
  ...LEGACY_CONTROL_CHANNEL_NAMES,
])

export function selectControlChannel(channels = []) {
  for (const name of CONTROL_CHANNEL_NAMES) {
    const channel = channels.find(candidate => candidate?.name === name && !candidate?.is_archived)
    if (channel) return channel
  }
  return null
}

export async function findControlChannel(fetchPage) {
  const channels = []
  let cursor = ''
  do {
    const page = await fetchPage(cursor)
    channels.push(...(page?.channels || []))
    cursor = page?.response_metadata?.next_cursor || ''
  } while (cursor)
  return selectControlChannel(channels)
}

// Codex permission responses are held by the daemon process and cannot survive
// its restart. Claude prompts may survive, but only while their agent PID does.
export function prunePermissionsOnBoot(permissions = {}, isAlive = () => false) {
  let pruned = 0
  for (const [id, request] of Object.entries(permissions)) {
    if (request?.provider === 'codex' || !request?.pid || !isAlive(request.pid)) {
      delete permissions[id]
      pruned++
    }
  }
  return pruned
}
