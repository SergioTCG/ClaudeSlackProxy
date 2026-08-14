import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTROL_CHANNEL_NAME, CONTROL_CHANNEL_NAMES, LEGACY_CONTROL_CHANNEL_NAMES,
  PRODUCT_NAME, REPOSITORY_SLUG, findControlChannel, selectControlChannel,
} from '../daemon/identity.mjs'

test('1.0 exposes a provider-neutral public identity', () => {
  assert.equal(PRODUCT_NAME, 'Slack Agent Bridge')
  assert.equal(REPOSITORY_SLUG, 'SlackAgentBridge')
  assert.equal(CONTROL_CHANNEL_NAME, 'slack-agent-bridge')
})

test('legacy control channels remain valid after the rename', () => {
  assert.deepEqual(LEGACY_CONTROL_CHANNEL_NAMES, ['claude-code-bridge'])
  assert.deepEqual(CONTROL_CHANNEL_NAMES, ['slack-agent-bridge', 'claude-code-bridge'])
  assert.equal(selectControlChannel([{ id: 'legacy', name: 'claude-code-bridge' }]).id, 'legacy')
})

test('the neutral control channel wins if both identities exist', () => {
  const selected = selectControlChannel([
    { id: 'legacy', name: 'claude-code-bridge' },
    { id: 'neutral', name: 'slack-agent-bridge' },
  ])
  assert.equal(selected.id, 'neutral')
  assert.equal(selectControlChannel([{ id: 'archived', name: 'slack-agent-bridge', is_archived: true }]), null)
})

test('control-channel recovery follows Slack pagination before creating one', async () => {
  const cursors = []
  const selected = await findControlChannel(async cursor => {
    cursors.push(cursor)
    if (!cursor) return {
      channels: [{ id: 'unrelated', name: 'private-project' }],
      response_metadata: { next_cursor: 'page-2' },
    }
    return {
      channels: [{ id: 'legacy', name: 'claude-code-bridge' }],
      response_metadata: { next_cursor: '' },
    }
  })
  assert.deepEqual(cursors, ['', 'page-2'])
  assert.equal(selected.id, 'legacy')
})
