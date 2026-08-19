import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../slack/app-manifest.json', import.meta.url), 'utf8'))
const commands = manifest.features.slash_commands
const names = commands.map(command => command.command)

test('Slack manifest has unique command names', () => {
  assert.equal(new Set(names).size, names.length)
})

test('Slack command definitions satisfy manifest field constraints', () => {
  for (const command of commands) {
    assert.match(command.command, /^\/[a-z0-9_-]{1,32}$/)
    assert.ok(command.description.length <= 75, `${command.command} description is too long`)
    assert.ok(!command.usage_hint || command.usage_hint.length <= 150, `${command.command} usage hint is too long`)
  }
  const scopes = new Set(manifest.oauth_config.scopes.bot)
  for (const scope of ['commands', 'chat:write', 'groups:write', 'groups:read', 'groups:history', 'files:write', 'files:read', 'users:read']) {
    assert.ok(scopes.has(scope), `missing required Slack scope ${scope}`)
  }
  assert.equal(manifest.settings.socket_mode_enabled, true)
  assert.equal(manifest.settings.interactivity.is_enabled, true)
})

test('Slack manifest has provider-neutral 1.0 metadata', () => {
  assert.equal(manifest.display_information.name, 'Slack Agent Bridge')
  assert.match(manifest.display_information.description, /Claude Code, Codex, and Pi/)
  assert.equal(manifest.features.bot_user.display_name, 'Clavdivs')
})

test('provider-scoped commands have parallel Claude, Codex, and Pi namespaces', () => {
  const scoped = ['new', 'model', 'effort', 'status', 'usage', 'flags', 'update', 'stop', 'switch', 'kill', 'help']
  for (const name of scoped) {
    assert.ok(names.includes(`/cc-${name}`), `missing /cc-${name}`)
    assert.ok(names.includes(`/codex-${name}`), `missing /codex-${name}`)
    assert.ok(names.includes(`/pi-${name}`), `missing /pi-${name}`)
  }
})

test('managed-run controls remain a Pi-only command and expose adaptive policy', () => {
  assert.ok(names.includes('/pi-run'))
  assert.ok(!names.includes('/cc-run'))
  assert.ok(!names.includes('/codex-run'))
  const command = commands.find(item => item.command === '/pi-run')
  assert.match(command.description, /managed/i)
  assert.match(command.usage_hint, /status/)
  assert.match(command.usage_hint, /mode/)
})

test('bridge-wide and Claude-only commands are not duplicated under Codex or Pi', () => {
  for (const name of ['claim', 'health', 'cleanup', 'account']) {
    assert.ok(names.includes(`/cc-${name}`), `missing /cc-${name}`)
    assert.ok(!names.includes(`/codex-${name}`), `unexpected /codex-${name}`)
    assert.ok(!names.includes(`/pi-${name}`), `unexpected /pi-${name}`)
  }
  const ccNew = commands.find(command => command.command === '/cc-new')
  assert.doesNotMatch(ccNew.usage_hint, /--codex/)
})
