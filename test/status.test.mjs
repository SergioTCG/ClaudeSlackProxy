import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createStatusMessages } from '../daemon/status.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')

function fakeSlack() {
  let next = 10
  const calls = []
  return {
    calls,
    web: { chat: {
      async postMessage(args) { const ts = `${next++}.000001`; calls.push(['post', args, ts]); return { ts } },
      async update(args) { calls.push(['update', args]) },
      async delete(args) { calls.push(['delete', args]) },
    } },
  }
}

test('working status edits in place until newer activity requests a bump', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working 1s')
  await status.set(session, 'working 2s')
  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'update'])
  assert.equal(slack.calls[1][1].ts, '10.000001')

  assert.equal(await status.bump(session, { afterTs: '11.000000' }), true)
  assert.deepEqual(slack.calls.slice(2).map(call => call[0]), ['post', 'delete'])
  assert.equal(slack.calls[2][1].text, 'working 2s')
  assert.equal(slack.calls[3][1].ts, '10.000001')

  await status.set(session, 'working 3s')
  assert.equal(slack.calls.at(-1)[0], 'update')
  assert.equal(slack.calls.at(-1)[1].ts, '11.000001')
})

test('activity older than the current status does not repost it', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working')
  assert.equal(await status.bump(session, { afterTs: '9.999999' }), false)
  assert.deepEqual(slack.calls.map(call => call[0]), ['post'])
})

test('concurrent updates and bumps are serialized onto the replacement message', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working 1s')
  await Promise.all([
    status.bump(session, { afterTs: '11.000000' }),
    status.set(session, 'working 2s'),
  ])

  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'post', 'delete', 'update'])
  assert.equal(slack.calls.at(-1)[1].ts, '11.000001')
  assert.equal(slack.calls.at(-1)[1].text, 'working 2s')
})

test('failed replacement deletion rolls back the new message and keeps the old status', async () => {
  const slack = fakeSlack()
  let failOldDelete = true
  slack.web.chat.delete = async args => {
    slack.calls.push(['delete', args])
    if (failOldDelete && args.ts === '10.000001') {
      failOldDelete = false
      const error = new Error('ratelimited')
      error.data = { error: 'ratelimited' }
      throw error
    }
  }
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working 1s')
  assert.equal(await status.bump(session, { afterTs: '11.000000' }), false)
  await status.set(session, 'working 2s')

  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'post', 'delete', 'delete', 'update'])
  assert.equal(slack.calls.at(-1)[1].ts, '10.000001')
})

test('clear removes the replacement status after a bump', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working')
  await status.bump(session, { afterTs: '11.000000' })
  await status.clear(session)

  assert.deepEqual(slack.calls.filter(call => call[0] === 'delete').map(call => call[1].ts), [
    '10.000001', '11.000001',
  ])
})

test('clear followed immediately by a new turn preserves the new status text', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'old turn')
  await Promise.all([
    status.clear(session),
    status.set(session, 'new turn'),
  ])

  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'delete', 'post'])
  assert.equal(slack.calls.at(-1)[1].text, 'new turn')
})

test('daemon re-anchors status after posts, topic changes, and channel messages', () => {
  assert.match(daemon, /async function postSlackMessage[\s\S]*bumpStatusForChannel\(channel, result\?\.ts\)/)
  assert.match(daemon, /const changed = await syncTopic[\s\S]*if \(changed\) await bumpStatus/)
  assert.match(daemon, /event\.subtype === 'channel_topic'[\s\S]*bumpStatusForChannel\(event\.channel, event\.ts \|\| null\)/)
  assert.match(daemon, /if \(!event\.thread_ts\) await bumpStatusForChannel\(event\.channel, event\.ts \|\| null\)/)
  assert.match(daemon, /liveStatuses\.adopt\(s\.id, ts\)/)
})

test('Codex stop waits for confirmation and clears only the interrupted turn', () => {
  assert.match(daemon, /waitForCodexInterrupt\(session/)
  assert.match(daemon, /interruptedTurnStartedAt = session\.codexTurnStartedAt/)
  assert.match(daemon, /outcome === 'idle'[\s\S]*stopPoller\(session\)[\s\S]*clearStatus\(session\)/)
  assert.match(daemon, /Codex did not return to idle[\s\S]*working status remains active/)
  assert.match(daemon, /codexStatusRecoveryDecision\(s,[\s\S]*cleared stale Codex turn status/)
})
