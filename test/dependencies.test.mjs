import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { z } from 'zod'

test('runtime dependency entry points used by the bridge are available', () => {
  assert.equal(typeof Server, 'function')
  assert.equal(typeof StdioServerTransport, 'function')
  assert.equal(typeof SocketModeClient, 'function')
  assert.equal(typeof WebClient, 'function')
  assert.equal(typeof z.object, 'function')
})

test('the bundled ccusage executable is installed', () => {
  const bin = new URL('../node_modules/.bin/ccusage', import.meta.url)
  assert.ok(fs.existsSync(bin))
})

test('the bundled ccusage exposes Codex session JSON', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-ccusage-codex-'))
  try {
    const bin = fileURLToPath(new URL('../node_modules/.bin/ccusage', import.meta.url))
    const run = spawnSync(bin, ['codex', 'session', '--json', '--offline', '--no-cost'], {
      encoding: 'utf8', env: { ...process.env, HOME: temp, CODEX_HOME: path.join(temp, '.codex') },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.ok(Array.isArray(JSON.parse(run.stdout).sessions))
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
