#!/usr/bin/env node
// Minimal channel server for the spike: declares the claude/channel capability
// and forwards every HTTP POST on 127.0.0.1:8790 into the session as a channel event.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import http from 'node:http'

const mcp = new Server(
  { name: 'sptest', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Events from the sptest channel arrive as <channel source="sptest">. ' +
      'They are test probes: reply in the conversation with exactly "RECEIVED: " followed by the event content. Do not use any tools.',
  },
)

await mcp.connect(new StdioServerTransport())

http
  .createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: body, meta: { probe: 'spike' } },
      })
      res.end('ok\n')
    } catch (e) {
      res.statusCode = 500
      res.end(String(e) + '\n')
    }
  })
  .listen(8790, '127.0.0.1')
