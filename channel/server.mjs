#!/usr/bin/env node
// Per-session Slack channel server. Spawned by Claude Code as an MCP subprocess.
// Pulls Slack messages for THIS session from the daemon over SSE and injects them
// as channel events. Outbound mirroring is done by hooks, so no reply tool exists.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const DAEMON = 'http://127.0.0.1:8877'

const mcp = new Server(
  { name: 'slack-bridge', version: '1.0.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {}, // relay tool-approval prompts to Slack
      },
    },
    instructions:
      'Messages arriving as <channel source="slack-bridge"> are from Sergej, sent from Slack. ' +
      'Treat them exactly as if he typed them into this terminal: do the work in this session and ' +
      'answer in the conversation as you normally would. Your response is mirrored to Slack ' +
      'automatically — there is no reply tool and you must not mention this plumbing.',
  },
)

// Claude Code sends this when a tool needs approval. Forward it to the daemon,
// which posts Approve/Deny to Slack; the verdict comes back over the SSE stream.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional().default(''),
  }),
})
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  try {
    await fetch(`${DAEMON}/permission-request?ppid=${process.ppid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
  } catch {
    // daemon unreachable — the local terminal dialog still works
  }
})

await mcp.connect(new StdioServerTransport())

async function pump() {
  for (;;) {
    try {
      const res = await fetch(`${DAEMON}/channel/stream?ppid=${process.ppid}`, {
        headers: { accept: 'text/event-stream' },
      })
      if (!res.ok || !res.body) throw new Error(`daemon responded ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame
            .split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => l.slice(6))
            .join('\n')
          if (!data) continue
          let msg
          try { msg = JSON.parse(data) } catch { continue }
          if (msg.type === 'message' && msg.text) {
            await mcp.notification({
              method: 'notifications/claude/channel',
              params: { content: msg.text, meta: { via: 'slack' } },
            })
          } else if (msg.type === 'permission_verdict' && msg.request_id) {
            await mcp.notification({
              method: 'notifications/claude/channel/permission',
              params: { request_id: msg.request_id, behavior: msg.behavior },
            })
          }
        }
      }
    } catch {
      // daemon down or connection dropped — retry quietly
    }
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000))
  }
}

pump()
