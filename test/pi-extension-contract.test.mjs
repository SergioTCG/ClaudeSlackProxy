import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const launcher = fs.readFileSync(new URL('../bin/sab-pi', import.meta.url), 'utf8')
const extension = fs.readFileSync(new URL('../pi/sab-extension.ts', import.meta.url), 'utf8')

test('Pi bridge extension is explicit and bridge safe mode never leaks to the Pi CLI', () => {
  assert.match(launcher, /pi --extension "\$EXTENSION"/)
  assert.match(launcher, /if \[ "\$arg" = "--safe" \]/)
  assert.doesNotMatch(launcher, /pi install/)
})

test('Pi transport uses native events and structured images without session-file parsing', () => {
  assert.match(extension, /pi\.sendUserMessage/)
  assert.match(extension, /mimeType: file\.mimetype/)
  assert.match(extension, /data: fs\.readFileSync/)
  assert.match(extension, /pi\.on\("agent_settled"/)
  assert.match(extension, /event: "AgentStart"/)
  assert.doesNotMatch(extension, /readFileSync\([^\n]*session_file/)
})

test('Pi safe-mode permission failures block tool execution', () => {
  assert.match(extension, /if \(!SAFE_MODE\) return undefined/)
  assert.match(extension, /return \{ block: true, reason: "Slack permission relay was unavailable\." \}/)
})
