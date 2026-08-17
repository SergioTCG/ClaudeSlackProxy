import test from 'node:test'
import assert from 'node:assert/strict'
import { reportSlashFailure } from '../daemon/slackout.mjs'

test('slash failures post visibly to the channel first', async () => {
  const calls = []
  const delivered = await reportSlashFailure({ command: '/cc-switch', channel_id: 'C1' }, {
    postChannel: async (channel, text) => calls.push({ kind: 'channel', channel, text }),
    postEphemeral: async () => calls.push({ kind: 'ephemeral' }),
  })

  assert.equal(delivered, 'channel')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].channel, 'C1')
  assert.match(calls[0].text, /cc-switch.*failed/i)
})

test('slash failures fall back to an ephemeral response when channel posting fails', async () => {
  const calls = []
  const body = { command: '/cc-switch', channel_id: 'C1' }
  const delivered = await reportSlashFailure(body, {
    postChannel: async () => { throw new Error('channel post failed') },
    postEphemeral: async (received, text) => calls.push({ received, text }),
  })

  assert.equal(delivered, 'ephemeral')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].received, body)
  assert.match(calls[0].text, /cc-switch.*failed/i)
})

test('slash failure reporting remains bounded when both Slack paths fail', async () => {
  const delivered = await reportSlashFailure({ command: '/cc-switch', channel_id: 'C1' }, {
    postChannel: async () => { throw new Error('channel post failed') },
    postEphemeral: async () => { throw new Error('ephemeral post failed') },
  })

  assert.equal(delivered, 'none')
})
