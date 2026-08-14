import test from 'node:test'
import assert from 'node:assert/strict'
import { createTopicSync } from '../daemon/topic.mjs'

test('topic sync reads Slack once and skips an unchanged topic after restart', async () => {
  const calls = { info: 0, set: 0 }
  const web = { conversations: {
    async info() { calls.info++; return { channel: { topic: { value: 'repo · main · model' } } } },
    async setTopic() { calls.set++ },
  } }
  const sync = createTopicSync(web)

  assert.equal(await sync('C1', 'repo · main · model'), false)
  assert.equal(await sync('C1', 'repo · main · model'), false)
  assert.deepEqual(calls, { info: 1, set: 0 })
})

test('topic sync writes only when the desired topic changes', async () => {
  const writes = []
  const web = { conversations: {
    async info() { return { channel: { topic: { value: 'old' } } } },
    async setTopic(args) { writes.push(args.topic) },
  } }
  const sync = createTopicSync(web)

  assert.equal(await sync('C1', 'new'), true)
  assert.equal(await sync('C1', 'new'), false)
  assert.equal(await sync('C1', 'newer'), true)
  assert.deepEqual(writes, ['new', 'newer'])
})

test('topic sync serializes concurrent startup updates per channel', async () => {
  let info = 0, set = 0
  const web = { conversations: {
    async info() { info++; await new Promise(resolve => setTimeout(resolve, 10)); return { channel: { topic: { value: 'old' } } } },
    async setTopic() { set++ },
  } }
  const sync = createTopicSync(web)

  await Promise.all([sync('C1', 'new'), sync('C1', 'new'), sync('C1', 'new')])
  assert.deepEqual({ info, set }, { info: 1, set: 1 })
})

test('topic sync retries a failed read without writing blindly', async () => {
  let attempts = 0, set = 0
  const web = { conversations: {
    async info() {
      attempts++
      if (attempts === 1) throw new Error('temporary Slack failure')
      return { channel: { topic: { value: 'same' } } }
    },
    async setTopic() { set++ },
  } }
  const sync = createTopicSync(web)

  await assert.rejects(sync('C1', 'same'), /temporary/)
  assert.equal(await sync('C1', 'same'), false)
  assert.deepEqual({ attempts, set }, { attempts: 2, set: 0 })
})
