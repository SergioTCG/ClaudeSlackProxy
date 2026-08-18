import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionChannelGate, pruneSessionChannelAliases } from '../daemon/channel-binding.mjs'

test('concurrent lifecycle hooks create one Slack channel for a session', async () => {
  const ensure = createSessionChannelGate()
  const session = { id: 'session-1', channel: null }
  let creates = 0
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const create = async () => {
    creates++
    await blocked
    session.channel = 'C_ACTIVE'
    return session.channel
  }

  const sessionStart = ensure(session, create)
  const userPromptSubmit = ensure(session, create)
  release()

  assert.equal(await sessionStart, 'C_ACTIVE')
  assert.equal(await userPromptSubmit, 'C_ACTIVE')
  assert.equal(creates, 1)
})

test('a failed channel creation releases the session gate for retry', async () => {
  const ensure = createSessionChannelGate()
  const session = { id: 'session-1', channel: null }
  let attempts = 0
  const create = async () => {
    attempts++
    if (attempts === 1) throw new Error('Slack unavailable')
    session.channel = 'C_RETRY'
    return session.channel
  }

  await assert.rejects(() => ensure(session, create), /Slack unavailable/)
  assert.equal(await ensure(session, create), 'C_RETRY')
  assert.equal(attempts, 2)
})

test('boot cleanup removes only aliases that disagree with the session channel', () => {
  const state = {
    sessions: {
      'session-1': { id: 'session-1', channel: 'C_ACTIVE' },
      'session-2': { id: 'session-2', channel: 'C_OTHER' },
    },
    channels: {
      C_ARCHIVED: 'session-1',
      C_ACTIVE: 'session-1',
      C_OTHER: 'session-2',
      C_UNKNOWN: 'missing-session',
    },
    channelTmux: {
      C_ARCHIVED: 'duplicate-tmux',
      C_ACTIVE: 'active-tmux',
      C_OTHER: 'other-tmux',
    },
  }

  assert.equal(pruneSessionChannelAliases(state), 1)
  assert.deepEqual(state.channels, {
    C_ACTIVE: 'session-1',
    C_OTHER: 'session-2',
    C_UNKNOWN: 'missing-session',
  })
  assert.deepEqual(state.channelTmux, {
    C_ACTIVE: 'active-tmux',
    C_OTHER: 'other-tmux',
  })
})
