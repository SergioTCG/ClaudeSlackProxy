import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../spike/slack-app-manifest.json', import.meta.url), 'utf8'))
const commands = manifest.features.slash_commands
const names = commands.map(command => command.command)

test('Slack manifest has unique command names', () => {
  assert.equal(new Set(names).size, names.length)
})

test('provider-scoped commands have parallel Claude and Codex namespaces', () => {
  const scoped = ['new', 'model', 'effort', 'status', 'flags', 'update', 'stop', 'kill', 'help']
  for (const name of scoped) {
    assert.ok(names.includes(`/cc-${name}`), `missing /cc-${name}`)
    assert.ok(names.includes(`/codex-${name}`), `missing /codex-${name}`)
  }
})

test('bridge-wide and Claude-only commands are not duplicated under Codex', () => {
  for (const name of ['claim', 'health', 'cleanup', 'usage', 'account']) {
    assert.ok(names.includes(`/cc-${name}`), `missing /cc-${name}`)
    assert.ok(!names.includes(`/codex-${name}`), `unexpected /codex-${name}`)
  }
  const ccNew = commands.find(command => command.command === '/cc-new')
  assert.doesNotMatch(ccNew.usage_hint, /--codex/)
})
