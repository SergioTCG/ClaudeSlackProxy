import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
