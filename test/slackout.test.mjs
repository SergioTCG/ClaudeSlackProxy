import test from 'node:test'
import assert from 'node:assert/strict'
import { mdToMessages, reportSlashFailure } from '../daemon/slackout.mjs'

const sectionsFor = markdown => mdToMessages(markdown)
  .flatMap(message => message.blocks || [])
  .filter(block => block.type === 'section')
  .map(block => block.text.text)

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

test('long prose is split at a word boundary instead of slicing a word', () => {
  // The old 2,900-character slice split the final word exactly as observed in
  // Slack: one section ended in "a" and the next began with "nd".
  const markdown = `${'word '.repeat(579)}xyz and it clears three failures`
  const sections = sectionsFor(markdown)

  assert.equal(sections.length, 2)
  assert.ok(sections.every(section => section.length <= 2900))
  assert.equal(sections[0].endsWith(' a'), false)
  assert.equal(sections[1].startsWith('nd '), false)
  assert.equal(sections.join(''), markdown)
})

test('long prose prefers a nearby paragraph boundary over a later space', () => {
  const first = 'First paragraph. '.repeat(125).trimEnd()
  const second = 'Second paragraph remains intact. '.repeat(80).trimEnd()
  const sections = sectionsFor(`${first}\n\n${second}`)

  assert.equal(sections.length, 2)
  assert.equal(sections[0], `${first}\n\n`)
  assert.equal(sections[1], second)
})

test('an oversized unbroken token is a bounded hard-split without corrupting Unicode', () => {
  const markdown = `x${'😀'.repeat(1800)}`
  const sections = sectionsFor(markdown)

  assert.ok(sections.length > 1)
  assert.ok(sections.every(section => section.length <= 2900))
  assert.equal(sections.join(''), markdown)
  assert.ok(sections.every(section => !/[\uD800-\uDBFF]$/.test(section) && !/^[\uDC00-\uDFFF]/.test(section)))
})

test('oversized fenced code is split into independently valid fenced sections', () => {
  const code = Array.from({ length: 220 }, (_, index) => `const value${index} = "${'x'.repeat(20)}";`).join('\n')
  const sections = sectionsFor(`\`\`\`js\n${code}\n\`\`\``)

  assert.ok(sections.length > 1)
  assert.ok(sections.every(section => section.length <= 2900))
  assert.ok(sections.every(section => /^```js\n/.test(section) && /\n```$/.test(section)))
  const recovered = sections.map(section => section.replace(/^```js\n/, '').replace(/```$/, '')).join('')
  assert.equal(recovered, `${code}\n`)
})

test('a complete fence moves intact when preceding prose leaves too little room', () => {
  const intro = 'Intro text. '.repeat(100)
  const code = `\`\`\`text\n${'value\n'.repeat(400)}\`\`\``
  const sections = sectionsFor(`${intro}\n${code}`)

  assert.equal(sections.length, 2)
  assert.equal(sections[0], `${intro}\n`)
  assert.equal(sections[1], code)
})

test('section boundaries do not bisect inline code or Slack links', () => {
  const prefix = 'word '.repeat(500)
  const inline = `\`${'inline value '.repeat(60)}\``
  const link = `<https://example.com/${'x'.repeat(240)}|${'linked label '.repeat(40)}>`
  const markdown = `${prefix}${inline} ${link}`
  const sections = sectionsFor(markdown)

  assert.ok(sections.length > 1)
  assert.equal(sections.join(''), markdown)
  assert.ok(sections.every(section => (section.match(/`/g) || []).length % 2 === 0))
  assert.ok(sections.every(section => (section.match(/</g) || []).length === (section.match(/>/g) || []).length))
})
