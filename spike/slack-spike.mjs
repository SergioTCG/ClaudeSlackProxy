#!/usr/bin/env node
// Slack-side spike: validates every Slack API mechanism the bridge design relies on.
// Run: set -a; source .env; set +a; node slack-spike.mjs
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'

const web = new WebClient(process.env.SLACK_BOT_TOKEN)
const results = []
const ctx = {}

async function step(name, fn) {
  try {
    const out = await fn()
    results.push({ step: name, ok: true, ...(out || {}) })
  } catch (e) {
    results.push({ step: name, ok: false, error: e?.data?.error || String(e).slice(0, 200) })
  }
}

await step('auth.test', async () => {
  const r = await web.auth.test()
  ctx.teamId = r.team_id
  ctx.botUserId = r.user_id
  return { team: r.team, team_id: r.team_id, bot_user: r.user_id }
})

await step('find-human-user', async () => {
  const r = await web.users.list({ limit: 50 })
  const humans = r.members.filter(m => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT')
  ctx.userId = humans[0]?.id
  return { picked: ctx.userId, name: humans[0]?.real_name || humans[0]?.name, human_count: humans.length }
})

const stamp = new Date().toTimeString().slice(0, 5).replace(':', '')
await step('conversations.create (private)', async () => {
  let name = `cc-spike-${stamp}`
  let r
  try {
    r = await web.conversations.create({ name, is_private: true })
  } catch (e) {
    if (e?.data?.error === 'name_taken') r = await web.conversations.create({ name: name + '-b', is_private: true })
    else throw e
  }
  ctx.channel = r.channel.id
  return { channel: r.channel.id, name: r.channel.name }
})

await step('conversations.invite (you)', async () => {
  await web.conversations.invite({ channel: ctx.channel, users: ctx.userId })
})

await step('conversations.rename (by bot)', async () => {
  const r = await web.conversations.rename({ channel: ctx.channel, name: `cc-spike-${stamp}-renamed` })
  return { new_name: r.channel.name }
})

await step('chat.postMessage', async () => {
  const r = await web.chat.postMessage({
    channel: ctx.channel,
    text: '👋 Bridge spike: this channel was created, you were invited, and it was renamed — all by the future daemon.',
  })
  ctx.parentTs = r.ts
})

await step('chat.update (edit-in-place status pattern)', async () => {
  const r = await web.chat.postMessage({ channel: ctx.channel, text: '⏺ status: starting…' })
  await web.chat.update({ channel: ctx.channel, ts: r.ts, text: '⏺ status: Running npm test… (edited in place ✅)' })
})

await step('table block', async () => {
  await web.chat.postMessage({
    channel: ctx.channel,
    text: 'table fallback text',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Native table block test:*' } },
      {
        type: 'table',
        rows: [
          [{ type: 'raw_text', text: 'Session' }, { type: 'raw_text', text: 'Branch' }, { type: 'raw_text', text: 'State' }],
          [{ type: 'raw_text', text: 'barrique-wt3' }, { type: 'raw_text', text: 'notif-fixes' }, { type: 'raw_text', text: 'active' }],
          [{ type: 'raw_text', text: 'caviste-main' }, { type: 'raw_text', text: 'main' }, { type: 'raw_text', text: 'dormant' }],
        ],
      },
    ],
  })
})

await step('assistant.threads.setStatus ("is thinking…")', async () => {
  await web.apiCall('assistant.threads.setStatus', {
    channel_id: ctx.channel,
    thread_ts: ctx.parentTs,
    status: 'is flibbertigibbeting…',
  })
})

await step('chat.startStream/appendStream/stopStream', async () => {
  const start = await web.apiCall('chat.startStream', {
    channel: ctx.channel,
    thread_ts: ctx.parentTs,
    recipient_user_id: ctx.userId,
    recipient_team_id: ctx.teamId,
  })
  ctx.streamTs = start.ts
  const chunks = [
    '## Streaming test\n\nThis text is arriving **incrementally** via `chat.appendStream`',
    ' — the same way Claude’s responses would stream into a thread',
    '.\n\n- markdown works\n- lists work\n- `code` works\n\n_done._',
  ]
  for (const c of chunks) {
    await web.apiCall('chat.appendStream', { channel: ctx.channel, ts: start.ts, markdown_text: c })
    await new Promise(r => setTimeout(r, 700))
  }
  await web.apiCall('chat.stopStream', { channel: ctx.channel, ts: start.ts })
  return { stream_ts: start.ts }
})

await step('socket-mode round-trip', async () => {
  const sm = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN })
  const received = []
  sm.on('message', async args => {
    try { await args.ack() } catch {}
    const ev = args.event
    if (ev?.channel === ctx.channel) received.push(ev.text?.slice(0, 60) || ev.subtype || 'event')
  })
  await sm.start()
  await web.chat.postMessage({ channel: ctx.channel, text: 'canary: socket-mode round-trip probe' })
  await new Promise(r => setTimeout(r, 8000))
  await sm.disconnect()
  if (!received.length) throw new Error('connected, but no event for canary message within 8s')
  return { events_received: received.length, sample: received[0] }
})

console.log('===RESULTS===')
console.log(JSON.stringify({ ctx: { channel: ctx.channel, userId: ctx.userId, teamId: ctx.teamId }, results }, null, 2))
