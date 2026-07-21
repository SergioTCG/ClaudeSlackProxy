#!/usr/bin/env node
// ClaudeSlackProxy daemon. Owns the Socket Mode connection and all bridge logic.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import {
  BRIDGE, log, sleep, loadEnv, loadState, saveState,
  resolveClaudePid, pidAlive, gitInfo, channelName,
  tmuxSendCommand, tmuxAlive, tmuxPaste, ghosttySpawn,
} from './util.mjs'
import { enqueue, mdToMessages, unescapeSlack, escapeText } from './slackout.mjs'

loadEnv()
const USER = process.env.SLACK_USER_ID
const TEAM = process.env.SLACK_TEAM_ID
const web = new WebClient(process.env.SLACK_BOT_TOKEN)
const state = loadState()

// pid → { res } live SSE connections from channel servers
const streams = new Map()
// sid → texts injected from Slack, awaiting their UserPromptSubmit echo (dedup)
const injectedRecently = new Map()
function rememberInjected(sid, text) {
  const a = injectedRecently.get(sid) || []
  a.push({ text: text.trim(), at: Date.now() })
  injectedRecently.set(sid, a.slice(-10))
}
function consumeInjected(sid, prompt) {
  const a = injectedRecently.get(sid) || []
  const p = prompt.trim()
  const i = a.findIndex(x => x.text === p && Date.now() - x.at < 120000)
  if (i >= 0) { a.splice(i, 1); return true }
  return false
}
const ALLOWED_FLAGS = new Set(['--dangerously-skip-permissions', '--chrome', '--continue', '--model', '--effort'])
const FLAG_ALIAS = { '--dsp': '--dangerously-skip-permissions' }
// request_id → { pid, channel, ts, tool } for open permission prompts relayed to Slack
const permReq = new Map()
const PERM_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---- session/channel helpers -----------------------------------------------
function sessionByPid(pid) {
  return Object.values(state.sessions).find(s => s.pid === pid)
}
function sessionByChannel(ch) {
  const sid = state.channels[ch]
  return sid ? state.sessions[sid] : null
}
function post(channel, text) {
  return enqueue(channel, () => web.chat.postMessage({ channel, text, unfurl_links: false }))
}
function postMd(channel, md) {
  const msgs = mdToMessages(md)
  return Promise.all(
    msgs.map(m => enqueue(channel, () => web.chat.postMessage({ channel, ...m, unfurl_links: false })))
  )
}

async function ensureChannel(session) {
  if (session.channel) return session.channel
  const { repo, branch } = await gitInfo(session.cwd)
  const name = channelName(repo, branch)
  let created
  try {
    created = await web.conversations.create({ name, is_private: true })
  } catch (e) {
    if (e?.data?.error === 'name_taken') created = await web.conversations.create({ name: name + '-' + Math.floor(Math.random() * 99), is_private: true })
    else throw e
  }
  const ch = created.channel.id
  session.channel = ch
  state.channels[ch] = session.id
  saveState(state)
  try { await web.conversations.invite({ channel: ch, users: USER }) } catch {}
  try { await web.conversations.setTopic({ channel: ch, topic: `${session.cwd} · ${branch || 'no-branch'}` }) } catch {}
  await post(ch, `🟢 *Session started*\n\`${session.cwd}\`\nBranch: \`${branch || '—'}\` · Session \`${session.id.slice(0, 8)}\``)
  return ch
}

// ---- status line (edit-in-place) -------------------------------------------
async function setStatus(session, text) {
  if (!session.channel) return
  try {
    if (session.statusTs) {
      await web.chat.update({ channel: session.channel, ts: session.statusTs, text })
    } else {
      const r = await web.chat.postMessage({ channel: session.channel, text })
      session.statusTs = r.ts
      saveState(state)
    }
  } catch {}
}
async function clearStatus(session) {
  if (session.channel && session.statusTs) {
    try { await web.chat.delete({ channel: session.channel, ts: session.statusTs }) } catch {}
    session.statusTs = null
    saveState(state)
  }
}

// ---- transcript mirroring ---------------------------------------------------
// The Stop hook can fire a beat before Claude flushes its final assistant text
// to the transcript. onHook runs AFTER the hook returns "ok" (TUI never waits),
// so we can settle-wait on the file size before reading.
async function waitTranscriptSettle(file, maxMs = 4000) {
  let last = -1, stable = 0
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    let size = 0
    try { size = fs.statSync(file).size } catch {}
    if (size === last) { if (++stable >= 2) return }
    else { stable = 0; last = size }
    await sleep(150)
  }
}

// Reads assistant text written since session.offset. Safe to call mid-turn:
// only advances offset past COMPLETE lines, so a record being flushed is never
// cut in half (which would orphan its bytes and lose the message).
function readNewAssistantText(session) {
  const f = session.transcript
  if (!f || !fs.existsSync(f)) return ''
  const size = fs.statSync(f).size
  const from = session.offset || 0
  if (size <= from) return ''
  const fd = fs.openSync(f, 'r')
  const buf = Buffer.alloc(size - from)
  fs.readSync(fd, buf, 0, buf.length, from)
  fs.closeSync(fd)
  const str = buf.toString('utf8')
  const lastNl = str.lastIndexOf('\n')
  if (lastNl < 0) return '' // no complete line yet; wait for more
  session.offset = from + Buffer.byteLength(str.slice(0, lastNl + 1), 'utf8')
  const out = []
  for (const line of str.slice(0, lastNl).split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type !== 'assistant' || !rec.message?.content) continue
    for (const c of rec.message.content) {
      if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim())
    }
  }
  return out.join('\n\n')
}

// ---- hook handling ----------------------------------------------------------
async function onHook(body, ppid, tmux) {
  const ev = body.hook_event_name
  const pid = await resolveClaudePid(ppid)
  if (!pid) return
  const sid = body.session_id

  let session = state.sessions[sid] || sessionByPid(pid)
  if (!session) {
    session = { id: sid, pid, cwd: body.cwd, tmux, transcript: body.transcript_path, offset: 0, channel: null, statusTs: null }
    state.sessions[sid] = session
  }
  // keep identity fresh (handles /clear: new sid, same pid)
  if (session.id !== sid) {
    delete state.sessions[session.id]
    if (session.channel) state.channels[session.channel] = sid
    session.id = sid
    session.offset = 0
    state.sessions[sid] = session
  }
  session.pid = pid
  session.tmux = tmux || session.tmux
  session.cwd = body.cwd || session.cwd
  session.transcript = body.transcript_path || session.transcript
  saveState(state)

  if (ev === 'SessionStart') {
    const ch = await ensureChannel(session)
    const src = body.source
    if (src === 'resume') await post(ch, '▶️ *Resumed*')
    else if (src === 'clear') await post(ch, '🧹 *Context cleared* — same channel, fresh session')
    // flush messages queued during resurrection: paste into the fresh terminal
    const queued = pendingBySid.get(sid) || []
    if (queued.length && session.tmux) {
      pendingBySid.set(sid, [])
      const tn = session.tmux
      setTimeout(async () => {
        for (const m of queued) {
          rememberInjected(sid, m)
          await tmuxPaste(tn, m).catch(e => log('flush paste failed', String(e)))
          await sleep(500)
        }
      }, 2000)
    }
    return
  }
  if (ev === 'UserPromptSubmit') {
    const ch = session.channel || (await ensureChannel(session))
    const p = (body.prompt || '').trim()
    // Skip prompts we injected from Slack (tmux paste = exact text match;
    // channel-event fallback = wrapped in <channel source="slack-bridge">).
    if (p && !consumeInjected(sid, p) && !p.includes('source="slack-bridge"')) {
      await post(ch, `💬 *You (terminal):*\n${p}`)
    }
    return
  }
  if (ev === 'PreToolUse') {
    // Stream out any prose Claude wrote before this tool call, so the channel
    // shows the turn unfolding instead of one dump at Stop. Clear the old status
    // first so a fresh "doing X now" line stays the newest message.
    const text = readNewAssistantText(session)
    if (text) { await clearStatus(session); await postMd(session.channel, text) }
    const name = body.tool_name || 'tool'
    const detail = body.tool_input?.command || body.tool_input?.file_path || body.tool_input?.description || ''
    await setStatus(session, `⏺ ${name}${detail ? ' — ' + String(detail).slice(0, 80) : ''}…`)
    return
  }
  if (ev === 'Stop') {
    await clearStatus(session)
    if (session.transcript) await waitTranscriptSettle(session.transcript)
    const text = readNewAssistantText(session)
    if (text) await postMd(session.channel, text)
    saveState(state)
    return
  }
  if (ev === 'SessionEnd') {
    await clearStatus(session)
    if (session.channel) await post(session.channel, '💤 *Session ended* — write here to resume it')
    session.pid = null
    saveState(state)
    return
  }
}

// ---- permission relay -------------------------------------------------------
async function postPermissionPrompt(channel, p) {
  const preview = String(p.input_preview || '').slice(0, 1200)
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `🔐 *Claude wants to use \`${escapeText(p.tool_name || 'a tool')}\`*\n${escapeText(String(p.description || '').slice(0, 600))}` } },
  ]
  if (preview) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + preview + '```' } })
  blocks.push(
    {
      type: 'actions', block_id: `perm_${p.request_id}`, elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✅ Approve' }, action_id: 'perm_allow', value: `allow:${p.request_id}` },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: '⛔ Deny' }, action_id: 'perm_deny', value: `deny:${p.request_id}` },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `or reply \`yes ${p.request_id}\` / \`no ${p.request_id}\`` }] },
  )
  const r = await enqueue(channel, () => web.chat.postMessage({ channel, text: `🔐 Permission needed: ${p.tool_name}`, blocks }))
  return r.ts
}

// Apply a verdict from a button tap or a text reply. Idempotent: unknown/expired ids are ignored.
async function applyVerdict(rid, behavior, channel, ts) {
  const req = permReq.get(rid)
  if (!req) return false
  permReq.delete(rid)
  const s = streams.get(req.pid)
  if (s) s.res.write(`data: ${JSON.stringify({ type: 'permission_verdict', request_id: rid, behavior })}\n\n`)
  log('verdict', behavior, rid, '→ session pid', req.pid)
  const decided = behavior === 'allow' ? '✅ *Approved*' : '⛔ *Denied*'
  try {
    await web.chat.update({ channel: channel || req.channel, ts: ts || req.ts, text: `${decided} ${req.tool}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${decided} \`${escapeText(req.tool)}\`` } }] })
  } catch {}
  return true
}

// ---- injection & resurrection ----------------------------------------------
function injectToSession(pid, text) {
  const s = streams.get(pid)
  if (s) {
    s.res.write(`data: ${JSON.stringify({ type: 'message', text })}\n\n`)
    return true
  }
  return false
}

async function resurrect(session, text) {
  await post(session.channel, '⏳ *Waking this session up on the Mac…*')
  const args = ['--resume', session.id]
  const tmuxName = `ccs-res-${Date.now().toString(36)}`
  session.tmux = tmuxName
  saveState(state)
  await ghosttySpawn({
    cwd: session.cwd,
    args,
    title: `ccs ${path.basename(session.cwd)} (resumed)`,
    tmuxName,
    autoConsent: true,
  })
  // the caller has already queued the message in pendingBySid;
  // SessionStart flushes it into the fresh terminal once the session is up
}
const pendingBySid = new Map()

async function handleSlackMessage(channel, text) {
  const trimmed = text.trim()

  // permission verdict by text ("yes abcde" / "no abcde")
  const pm = PERM_REPLY_RE.exec(trimmed)
  if (pm) {
    const ok = await applyVerdict(pm[2].toLowerCase(), /^y/i.test(pm[1]) ? 'allow' : 'deny', channel)
    if (!ok) await post(channel, '⚠️ No open permission request with that code (it may have been answered or expired).')
    return
  }

  // commands
  if (trimmed.startsWith('./')) {
    log('command', channel, JSON.stringify(trimmed.slice(0, 60)))
    return handleCommand(channel, trimmed)
  }

  const session = sessionByChannel(channel)
  if (!session) {
    if (channel === state.control) return post(channel, "This is the control channel. Try `./new <dir> [--dsp] [--chrome]` or `./status`.")
    log('inbound (unmapped channel, ignored)', channel)
    return
  }
  const alive = session.pid && pidAlive(session.pid)

  // 1st choice: paste into the visible terminal — full message shows in the TUI
  if (alive && session.tmux && (await tmuxAlive(session.tmux))) {
    rememberInjected(session.id, trimmed)
    try {
      await tmuxPaste(session.tmux, trimmed)
      log('inject (tmux) → session', session.id.slice(0, 8), JSON.stringify(trimmed.slice(0, 50)))
      return
    } catch (e) {
      log('tmux paste failed, falling back to channel event', String(e))
    }
  }
  // fallback: channel event via the MCP plugin (no-tmux/headless sessions)
  if (alive && injectToSession(session.pid, trimmed)) {
    log('inject (channel) → session', session.id.slice(0, 8), JSON.stringify(trimmed.slice(0, 50)))
    return
  }

  // dead or detached → resurrect
  log('resurrect', session.id.slice(0, 8), 'pid', session.pid, 'cwd', session.cwd)
  const q = pendingBySid.get(session.id) || []
  pendingBySid.set(session.id, [...q, trimmed])
  if (!alive) await resurrect(session, trimmed)
}

async function handleCommand(channel, cmd) {
  const [name, ...rest] = cmd.slice(2).split(/\s+/)
  if (name === 'help') {
    return post(channel, '*Commands*\n`./new <dir> [--dsp] [--chrome] [--model X]` — spawn a session\n`./model <m>` · `./effort <e>` — in a session channel\n`./status` — list sessions')
  }
  if (name === 'status') {
    const rows = Object.values(state.sessions).map(s => {
      const alive = s.pid && pidAlive(s.pid)
      return `| ${path.basename(s.cwd)} | ${s.id.slice(0, 8)} | ${alive ? '🟢 active' : '💤 dormant'} |`
    })
    return postMd(channel, `| Session | ID | State |\n|---|---|---|\n${rows.join('\n') || '| _none_ | | |'}`)
  }
  if (name === 'model' || name === 'effort') {
    const session = sessionByChannel(channel)
    if (!session?.tmux || !(session.pid && pidAlive(session.pid))) return post(channel, `Can't send \`/${name}\` — session not active. Send a message first to wake it.`)
    await tmuxSendCommand(session.tmux, `/${name} ${rest.join(' ')}`)
    return post(channel, `↪️ sent \`/${name} ${rest.join(' ')}\` to the session`)
  }
  if (name === 'new') {
    const dir = rest[0]
    if (!dir) return post(channel, 'Usage: `./new <dir> [flags]`')
    const cwd = path.resolve(dir.replace(/^~/, process.env.HOME))
    if (!cwd.startsWith(process.env.HOME) || !fs.existsSync(cwd)) return post(channel, `❌ Directory not allowed or missing: \`${cwd}\``)
    const flags = []
    for (const f of rest.slice(1)) {
      const norm = FLAG_ALIAS[f] || f
      const base = norm.split('=')[0]
      if (ALLOWED_FLAGS.has(base)) flags.push(norm)
      else return post(channel, `❌ Flag not allowed: \`${f}\``)
    }
    const tmuxName = `ccs-new-${Date.now().toString(36)}`
    await post(channel, `🚀 Spawning \`claude ${flags.join(' ')}\` in \`${cwd}\`…`)
    await ghosttySpawn({ cwd, args: flags, title: `ccs ${path.basename(cwd)}`, tmuxName, autoConsent: true })
    return
  }
  return post(channel, `Unknown command: \`./${name}\`. Try \`./help\`.`)
}

// ---- HTTP (hooks in, SSE out) ----------------------------------------------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/hook' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try { await onHook(JSON.parse(body), url.searchParams.get('ppid'), url.searchParams.get('tmux')) }
    catch (e) { log('hook error', String(e)) }
    return
  }
  if (url.pathname === '/permission-request' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      const p = JSON.parse(body)
      const pid = await resolveClaudePid(url.searchParams.get('ppid'))
      const session = sessionByPid(pid)
      if (!session?.channel) { log('perm-request: no channel for pid', pid); return }
      const ts = await postPermissionPrompt(session.channel, p)
      permReq.set(p.request_id, { pid, channel: session.channel, ts, tool: p.tool_name || 'tool' })
      log('perm-request', p.request_id, p.tool_name, '→', session.id.slice(0, 8))
    } catch (e) { log('perm-request error', String(e)) }
    return
  }
  if (url.pathname === '/channel/stream') {
    const ppid = Number(url.searchParams.get('ppid'))
    const pid = await resolveClaudePid(ppid)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n')
    streams.set(pid, { res })
    log('channel attached pid', pid)
    // attach to a session record and flush any queued messages for its sid
    const session = sessionByPid(pid)
    if (session) {
      const q = pendingBySid.get(session.id)
      if (q?.length) { for (const m of q) injectToSession(pid, m); pendingBySid.set(session.id, []) }
    }
    const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
    req.on('close', () => { clearInterval(ka); if (streams.get(pid)?.res === res) streams.delete(pid) })
    return
  }
  res.writeHead(404); res.end()
}).listen(8877, '127.0.0.1', () => log('daemon http on 127.0.0.1:8877'))

// ---- Slack Socket Mode ------------------------------------------------------
const sm = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN })
sm.on('message', async ({ event, ack }) => {
  try { await ack() } catch {}
  if (!event || event.bot_id || event.subtype) return
  if (event.user !== USER) return // single trusted sender
  try { await handleSlackMessage(event.channel, unescapeSlack(event.text || '')) }
  catch (e) { log('slack msg error', String(e)) }
})

// Approve/Deny button taps arrive as interactive (block_actions) envelopes.
sm.on('interactive', async ({ body, ack }) => {
  try { await ack() } catch {}
  try {
    if (body?.type !== 'block_actions' || body.user?.id !== USER) return
    const action = body.actions?.[0]
    if (!action?.value) return
    const [behavior, rid] = String(action.value).split(':')
    await applyVerdict(rid, behavior, body.channel?.id, body.message?.ts)
  } catch (e) { log('interactive error', String(e)) }
})

// ---- liveness sweep ---------------------------------------------------------
setInterval(async () => {
  for (const s of Object.values(state.sessions)) {
    if (s.pid && !pidAlive(s.pid)) {
      log('sweep: pid dead', s.pid, s.id.slice(0, 8))
      await clearStatus(s)
      if (s.channel) await post(s.channel, '💤 *Session ended* — write here to resume it')
      s.pid = null
      saveState(state)
    }
  }
}, 30000)

// ---- boot -------------------------------------------------------------------
;(async () => {
  const r = await web.auth.test()
  log('slack auth ok:', r.team, 'bot', r.user)
  if (!state.control) {
    try {
      const c = await web.conversations.create({ name: 'claude-code-bridge', is_private: true })
      state.control = c.channel.id
      await web.conversations.invite({ channel: c.channel.id, users: USER })
      await post(c.channel.id, '🤖 *Bridge online.* `./new <dir> [--dsp] [--chrome]`, `./status`, `./help`.')
    } catch (e) {
      if (e?.data?.error === 'name_taken') {
        const list = await web.conversations.list({ types: 'private_channel', limit: 200 })
        state.control = list.channels.find(c => c.name === 'claude-code-bridge')?.id || null
      }
    }
    saveState(state)
  }
  await sm.start()
  log('socket mode connected — bridge ready')
})().catch(e => { log('BOOT FAILED', e); process.exit(1) })
