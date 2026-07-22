#!/usr/bin/env node
// ClaudeSlackProxy daemon. Owns the Socket Mode connection and all bridge logic.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import {
  BRIDGE, log, sleep, loadEnv, loadState, saveState,
  resolveClaudePid, pidAlive, gitInfo, gitStatusText, gitBranch, channelName,
  tmuxSendCommand, tmuxAlive, tmuxKill, tmuxCapture, tmuxInterrupt, tmuxPaste,
  ghosttySpawn, setKillOnClose,
} from './util.mjs'
import { enqueue, mdToMessages, unescapeSlack, escapeText } from './slackout.mjs'

loadEnv()
const USER = process.env.SLACK_USER_ID
const TEAM = process.env.SLACK_TEAM_ID
const web = new WebClient(process.env.SLACK_BOT_TOKEN)
const state = loadState()
if (!state.perms) state.perms = {} // open permission prompts, survive daemon restarts
const BOOT_TS = Date.now()

// Safety net: a single Slack API error (e.g. posting to an archived channel from
// a timer) must never crash the long-running daemon.
process.on('unhandledRejection', e => log('unhandledRejection:', e?.data?.error || e?.stack || String(e)))
process.on('uncaughtException', e => log('uncaughtException:', e?.stack || String(e)))

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
const MAX_INLINE = 6000 // longer responses upload as a file instead of many messages
async function postMd(channel, md) {
  if (md.length > MAX_INLINE) {
    return enqueue(channel, () => web.files.uploadV2({
      channel_id: channel,
      content: md,
      filename: 'response.md',
      title: 'response.md',
      initial_comment: `📄 Long response (${md.length.toLocaleString()} chars) — attached:`,
    })).catch(async e => {
      log('file upload failed, falling back to inline', String(e))
      for (const m of mdToMessages(md)) await enqueue(channel, () => web.chat.postMessage({ channel, ...m, unfurl_links: false }))
    })
  }
  for (const m of mdToMessages(md)) await enqueue(channel, () => web.chat.postMessage({ channel, ...m, unfurl_links: false }))
}

async function ensureChannel(session) {
  if (session.channel) return session.channel
  const { repo, branch, worktree } = await gitInfo(session.cwd)
  const name = channelName(repo, branch, worktree)
  let created
  try {
    created = await web.conversations.create({ name, is_private: true })
  } catch (e) {
    if (e?.data?.error === 'name_taken') created = await web.conversations.create({ name: name + '-' + Math.floor(Math.random() * 99), is_private: true })
    else throw e
  }
  const ch = created.channel.id
  session.channel = ch
  session.worktree = worktree
  state.channels[ch] = session.id
  saveState(state)
  try { await web.conversations.invite({ channel: ch, users: USER }) } catch {}
  await updateTopic(session)
  await post(ch, `🟢 *Session started*\n\`${session.cwd}\`\nBranch: \`${branch || '—'}\` · Session \`${session.id.slice(0, 8)}\``)
  return ch
}

// Reactive channel topic: folder · branch · model · effort. Deduped, so Slack is
// only called when something actually changes. Driven by the statusline feed
// (model/effort/cwd) plus a live branch check.
const lastTopic = new Map() // channel → last topic string
const lastTopicAt = new Map() // channel → last rebuild time
async function updateTopic(session) {
  if (!session.channel) return
  const meta = sessionMeta.get(session.id) || {}
  const branch = await gitBranch(session.cwd)
  const topic = [
    session.cwd,
    branch || 'no-branch',
    session.worktree ? 'wt:' + session.worktree : '',
    meta.model, meta.effort,
  ].filter(Boolean).join(' · ')
  if (topic === lastTopic.get(session.channel)) return
  lastTopic.set(session.channel, topic)
  try { await web.conversations.setTopic({ channel: session.channel, topic: topic.slice(0, 250) }) }
  catch (e) { log('setTopic error', e?.data?.error || String(e)) }
}

// ---- status line (edit-in-place) -------------------------------------------
// The live status message ts is keyed by session id in a daemon-level map, not on
// the session object — the poller and the Stop handler may hold different object
// references for the same session, so a shared key avoids a stale/orphaned message.
const statusTs = new Map() // sid → ts
async function setStatus(session, text) {
  if (!session.channel) return
  const ts = statusTs.get(session.id)
  try {
    if (ts) {
      await web.chat.update({ channel: session.channel, ts, text })
    } else {
      const r = await web.chat.postMessage({ channel: session.channel, text })
      statusTs.set(session.id, r.ts)
    }
  } catch (e) {
    if (e?.data?.error === 'message_not_found') statusTs.delete(session.id) // stale ts (deleted); repost next tick
    else log('setStatus error:', e?.data?.error || String(e))
  }
}
async function clearStatus(session) {
  const ts = statusTs.get(session.id)
  if (session.channel && ts) {
    try { await web.chat.delete({ channel: session.channel, ts }) } catch {}
    statusTs.delete(session.id)
  }
}

// ---- live status poller -----------------------------------------------------
// While a turn runs, mirror the terminal's spinner line (verb + elapsed + tokens)
// into the edit-in-place status message. Reads rendered pane output, not internals.
const pollers = new Map() // sid → { timer, last }
function extractSpinner(pane) {
  const lines = pane.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    // e.g. "✶ Newspapering… (8s · ↓ 487 tokens · thought for 1s)"
    const m = lines[i].match(/([A-Za-z][A-Za-z ]*…\s*\(.*?\))/)
    if (m) return '⚙️ ' + m[1].replace(/\s+/g, ' ').trim()
  }
  return null
}
function startPoller(session) {
  if (pollers.has(session.id)) return
  const p = { timer: null, last: '', stopped: false }
  p.timer = setInterval(async () => {
    if (p.stopped || !session.tmux || !(session.pid && pidAlive(session.pid))) return
    const line = extractSpinner(await tmuxCapture(session.tmux))
    if (p.stopped) return // Stop fired during the capture — don't re-post
    if (line && line !== p.last) { p.last = line; await setStatus(session, line) }
  }, 3000)
  pollers.set(session.id, p)
}
function stopPoller(session) {
  const p = pollers.get(session.id)
  if (p) { p.stopped = true; clearInterval(p.timer); pollers.delete(session.id) }
}

// System-injected prompts (task notifications, reminders, local-command echoes)
// arrive via UserPromptSubmit but aren't genuine typing — don't mirror them.
function isSystemPrompt(p) {
  return /SYSTEM NOTIFICATION|task-notification|<system-reminder>|<command-name>|<local-command|Caveat: The messages below/i.test(p)
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
    if (session.tmux) setKillOnClose(session.tmux) // closing the window terminates claude
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
    // Mirror only genuine typing: skip Slack-injected prompts (already shown) and
    // system-injected content (task notifications, reminders, local-command echoes).
    if (p && !consumeInjected(sid, p) && !p.includes('source="slack-bridge"') && !isSystemPrompt(p)) {
      await post(ch, `💬 *You (terminal):*\n${p}`)
    }
    startPoller(session) // live spinner status while the turn runs
    return
  }
  if (ev === 'PreToolUse') {
    // Stream out any prose Claude wrote before this tool call, so the channel
    // shows the turn unfolding. Clearing the status lets the poller repost the
    // live spinner below the new prose on its next tick.
    const text = readNewAssistantText(session)
    if (text) { await clearStatus(session); await postMd(session.channel, text) }
    return
  }
  if (ev === 'Stop') {
    stopPoller(session)
    await clearStatus(session)
    if (session.transcript) await waitTranscriptSettle(session.transcript)
    const text = readNewAssistantText(session)
    if (text) await postMd(session.channel, text)
    saveState(state)
    return
  }
  if (ev === 'SessionEnd') {
    stopPoller(session)
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
  const req = state.perms[rid]
  if (!req) return false
  delete state.perms[rid]
  saveState(state)
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

  // The ./ commands were retired in favour of native /cc-* slash commands; nudge.
  const dot = /^\.\/(\w+)/.exec(trimmed)
  if (dot && RETIRED_CMDS.has(dot[1])) {
    return post(channel, `\`./\` commands are retired — use \`/cc-${dot[1]}\` instead (type \`/cc-\` for the list).`)
  }

  const session = sessionByChannel(channel)
  if (!session) {
    if (channel === state.control) return post(channel, 'This is the control channel. Use `/cc-new` to start a session, or `/cc-status` to list them.')
    log('inbound (unmapped channel, ignored)', channel)
    return
  }
  await injectText(session, trimmed)
}
const RETIRED_CMDS = new Set(['model', 'effort', 'new', 'status', 'health', 'kill', 'cleanup', 'stop', 'help'])

// Deliver text into a session: prefer a tmux paste (full text shows in the TUI),
// fall back to a channel event, and resurrect the session if it's gone.
async function injectText(session, text) {
  const alive = session.pid && pidAlive(session.pid)
  if (alive && session.tmux && (await tmuxAlive(session.tmux))) {
    rememberInjected(session.id, text)
    try {
      await tmuxPaste(session.tmux, text)
      log('inject (tmux) → session', session.id.slice(0, 8), JSON.stringify(text.slice(0, 50)))
      return
    } catch (e) {
      log('tmux paste failed, falling back to channel event', String(e))
    }
  }
  if (alive && injectToSession(session.pid, text)) {
    log('inject (channel) → session', session.id.slice(0, 8), JSON.stringify(text.slice(0, 50)))
    return
  }
  log('resurrect', session.id.slice(0, 8), 'pid', session.pid, 'cwd', session.cwd)
  const q = pendingBySid.get(session.id) || []
  pendingBySid.set(session.id, [...q, text])
  if (!alive) await resurrect(session, text)
}

// Fetch a Slack file with the bot token. Slack redirects url_private to its file
// origin on the same domain, so fetch keeps the Authorization header. Right after
// upload Slack briefly serves an HTML login page instead of the bytes, so retry
// with backoff until the real content shows up.
async function downloadSlackFile(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } })
      const ct = res.headers.get('content-type') || ''
      if (res.ok && !ct.includes('text/html')) return Buffer.from(await res.arrayBuffer())
    } catch (e) { log('download attempt failed', String(e)) }
    await sleep(800 * (i + 1))
  }
  return null
}

// Download files shared in a channel and inject them as local paths Claude can read.
async function handleAttachments(channel, caption, files) {
  const session = sessionByChannel(channel)
  if (!session) { log('attachment in unmapped channel, ignored', channel); return }
  const dir = path.join(process.env.HOME, '.claude', 'ccs-attachments')
  fs.mkdirSync(dir, { recursive: true })
  const saved = []
  for (const f of files) {
    const dl = f.url_private_download || f.url_private
    if (!dl) continue
    const buf = await downloadSlackFile(dl)
    if (!buf) {
      log('attachment download failed', f.name)
      await post(channel, `⚠️ Couldn’t download \`${f.name || f.id}\` from Slack — try resending it.`)
      continue
    }
    const safe = String(f.name || f.id).replace(/[^\w.\-]+/g, '_')
    const p = path.join(dir, `${Date.now().toString(36)}-${safe}`)
    fs.writeFileSync(p, buf)
    saved.push(p)
    log('attachment saved', p, buf.length + 'b')
  }
  if (!saved.length) return
  const list = saved.map(p => `  • ${p}`).join('\n')
  const body = caption?.trim()
    ? `${caption.trim()}\n\n(I attached ${saved.length} file(s) from Slack — read them if relevant:\n${list}\n)`
    : `I attached ${saved.length} file(s) from Slack. Please read them:\n${list}`
  await injectText(session, body)
}

const sessionMeta = new Map() // sid → { model, effort } as set via the bridge

// Read the session's model from its transcript init record (first "model" field).
function readModel(session) {
  try {
    const fd = fs.openSync(session.transcript, 'r')
    const buf = Buffer.alloc(65536)
    const n = fs.readSync(fd, buf, 0, 65536, 0)
    fs.closeSync(fd)
    const m = buf.toString('utf8', 0, n).match(/"model":"([^"]+)"/)
    if (m) return m[1]
  } catch {}
  return null
}

async function spawnNew(channel, dir, extraFlags) {
  const cwd = path.resolve(dir.replace(/^~/, process.env.HOME))
  if (!cwd.startsWith(process.env.HOME) || !fs.existsSync(cwd)) return post(channel, `❌ Directory not allowed or missing: \`${cwd}\``)
  const flags = []
  for (const f of extraFlags) {
    const norm = FLAG_ALIAS[f] || f
    if (ALLOWED_FLAGS.has(norm.split('=')[0])) flags.push(norm)
    else return post(channel, `❌ Flag not allowed: \`${f}\``)
  }
  const tmuxName = `ccs-new-${Date.now().toString(36)}`
  await post(channel, `🚀 Spawning \`claude ${flags.join(' ')}\` in \`${cwd}\`…`)
  await ghosttySpawn({ cwd, args: flags, title: `ccs ${path.basename(cwd)}`, tmuxName, autoConsent: true })
}

const codeDir = () => process.env.CCS_CODE_DIR || path.join(process.env.HOME, 'Code')
async function postFolderPicker(channel) {
  const base = codeDir()
  let dirs = []
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort() } catch {}
  if (!dirs.length) return post(channel, `No projects in \`${base}\`. Set CCS_CODE_DIR, or use \`/cc-new <folder>\`.`)
  const options = dirs.slice(0, 100).map(d => ({ text: { type: 'plain_text', text: d.slice(0, 75) }, value: d.slice(0, 75) }))
  await web.chat.postMessage({
    channel, text: 'Pick a project to start a session in',
    blocks: [{
      type: 'section', text: { type: 'mrkdwn', text: `*Start a session* — pick a project in \`${base}\`:` },
      accessory: { type: 'static_select', action_id: 'ccnew_folder', placeholder: { type: 'plain_text', text: 'Choose a project…' }, options },
    }],
  })
}

// Command dispatch for the native /cc-* slash commands.
async function dispatch(name, rest, channel) {
  if (name === 'help') {
    return post(channel,
      '*Commands* — use `/cc-<name>` (autocompletes as you type `/cc-`)\n' +
      '`/cc-new [folder] [--dsp] [--chrome]` — start a session (no arg = pick a project)\n' +
      '`/cc-model [m]` · `/cc-effort [e]` — show or set (no arg = show current)\n' +
      '`/cc-stop` — interrupt the running turn\n' +
      '`/cc-status` — session info here, or all sessions from the control channel\n' +
      '`/cc-health` — bridge status\n' +
      '`/cc-kill [here|<id>]` — end a session (channel stays, resumable)\n' +
      '`/cc-cleanup` — archive dormant channels')
  }
  if (name === 'status') {
    const session = channel !== state.control ? sessionByChannel(channel) : null
    if (session) {
      const { branch, worktree } = await gitInfo(session.cwd)
      const gs = await gitStatusText(session.cwd)
      const alive = session.pid && pidAlive(session.pid)
      const meta = sessionMeta.get(session.id) || {}
      const changes = gs ? `${gs.split('\n').length} file(s) changed` : '✓ clean'
      // Table cells are raw text (no markdown), so no backticks here.
      return postMd(channel,
        `*Session ${session.id.slice(0, 8)}* — ${alive ? '🟢 active' : '💤 dormant'}\n` +
        `| Field | Value |\n|---|---|\n` +
        `| Folder | ${session.cwd} |\n` +
        `| Branch | ${branch || '—'}${worktree ? ` · wt:${worktree}` : ''} |\n` +
        `| Model | ${meta.model || readModel(session) || '—'} |\n` +
        `| Effort | ${meta.effort || '—'} |\n` +
        `| Changes | ${changes} |` +
        (gs ? '\n```\n' + gs.slice(0, 1200) + '\n```' : ''))
    }
    const rows = Object.values(state.sessions).map(s => {
      const alive = s.pid && pidAlive(s.pid)
      return `| ${path.basename(s.cwd)} | ${s.id.slice(0, 8)} | ${alive ? '🟢 active' : '💤 dormant'} |`
    })
    return postMd(channel, `| Session | ID | State |\n|---|---|---|\n${rows.join('\n') || '| _none_ | | |'}`)
  }
  if (name === 'health') {
    const sess = Object.values(state.sessions)
    const active = sess.filter(s => s.pid && pidAlive(s.pid)).length
    const up = Math.round((Date.now() - BOOT_TS) / 1000)
    const hms = up < 3600 ? `${Math.round(up / 60)}m` : `${(up / 3600).toFixed(1)}h`
    return postMd(channel,
      `| Bridge health | |\n|---|---|\n` +
      `| Uptime | ${hms} |\n` +
      `| Sessions | ${active} active, ${sess.length - active} dormant |\n` +
      `| Channel servers attached | ${streams.size} |\n` +
      `| Open permission prompts | ${Object.keys(state.perms).length} |`)
  }
  if (name === 'kill') {
    const target = rest[0] && rest[0] !== 'here'
      ? Object.values(state.sessions).find(s => s.id.startsWith(rest[0]))
      : sessionByChannel(channel)
    if (!target) return post(channel, 'No matching session — use `/cc-kill` in a session channel, or `/cc-kill <id-prefix>`.')
    if (target.tmux) await tmuxKill(target.tmux)
    if (target.pid && pidAlive(target.pid)) { try { process.kill(target.pid) } catch {} }
    await clearStatus(target)
    target.pid = null
    saveState(state)
    return post(channel, `🛑 Ended session \`${target.id.slice(0, 8)}\` (${path.basename(target.cwd)}). The channel stays — write here to resume.`)
  }
  if (name === 'cleanup') {
    const dead = Object.values(state.sessions).filter(s => s.channel && s.channel !== channel && !(s.pid && pidAlive(s.pid)))
    if (!dead.length) return post(channel, 'No dormant channels to archive (skipping the one you’re in).')
    let n = 0
    for (const s of dead) {
      try { await web.conversations.archive({ channel: s.channel }); n++ } catch (e) { log('archive failed', s.channel, e?.data?.error) }
      delete state.channels[s.channel]
      delete state.sessions[s.id]
    }
    saveState(state)
    return post(channel, `🧹 Archived ${n} dormant channel(s). Note: archived channels can’t auto-resume — unarchive manually in Slack if you need one back.`)
  }
  if (name === 'model' || name === 'effort') {
    const session = sessionByChannel(channel)
    if (!session) return post(channel, `Use \`/cc-${name}\` in a session channel.`)
    const meta = sessionMeta.get(session.id) || {}
    if (!rest.length) {
      const cur = name === 'model' ? (meta.model || readModel(session) || 'unknown') : (meta.effort || 'unknown')
      const opts = name === 'model' ? 'sonnet · opus · haiku · fable' : 'low · medium · high · max'
      return post(channel, `*${name}*: \`${cur}\`\nSet with \`/cc-${name} <value>\`  (${opts})`)
    }
    if (!(session.pid && pidAlive(session.pid))) return post(channel, 'Session not active — send a message first to wake it.')
    await tmuxSendCommand(session.tmux, `/${name} ${rest.join(' ')}`)
    sessionMeta.set(session.id, { ...meta, [name]: rest.join(' ') })
    return post(channel, `✅ ${name} → \`${rest.join(' ')}\``)
  }
  if (name === 'stop') {
    const session = sessionByChannel(channel)
    if (!session?.tmux || !(session.pid && pidAlive(session.pid))) return post(channel, 'No active session here to interrupt.')
    await tmuxInterrupt(session.tmux)
    return post(channel, '⎋ *Interrupted* the running turn.')
  }
  if (name === 'new') {
    if (!rest.length) return postFolderPicker(channel)
    return spawnNew(channel, rest[0], rest.slice(1))
  }
  return post(channel, `Unknown command: \`${name}\`. Try \`/cc-help\`.`)
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
  if (url.pathname === '/statusline' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      const j = JSON.parse(body)
      if (j.session_id) {
        const prev = sessionMeta.get(j.session_id) || {}
        const next = {
          ...prev,
          model: j.model?.display_name || prev.model,
          effort: j.effort?.level || prev.effort,
          ctxPct: j.context_window?.used_percentage ?? prev.ctxPct,
          cost: j.cost?.total_cost_usd ?? prev.cost,
        }
        sessionMeta.set(j.session_id, next)
        const session = state.sessions[j.session_id]
        if (session?.channel) {
          if (j.cwd) session.cwd = j.cwd // folder can change; keep it current
          const changed = prev.model !== next.model || prev.effort !== next.effort
          if (changed || Date.now() - (lastTopicAt.get(session.channel) || 0) > 6000) {
            lastTopicAt.set(session.channel, Date.now())
            await updateTopic(session)
          }
        }
      }
    } catch {}
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
      state.perms[p.request_id] = { pid, channel: session.channel, ts, tool: p.tool_name || 'tool' }
      saveState(state)
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
  if (!event || event.bot_id) return
  // allow normal messages and file shares; skip edits/joins/other subtypes
  if (event.subtype && event.subtype !== 'file_share') return
  if (event.user !== USER) return // single trusted sender
  try {
    const text = unescapeSlack(event.text || '')
    if (event.files?.length) await handleAttachments(event.channel, text, event.files)
    else await handleSlackMessage(event.channel, text)
  } catch (e) { log('slack msg error', String(e)) }
})

// Native /cc-* slash commands (registered in the manifest, delivered over the socket).
sm.on('slash_commands', async ({ body, ack }) => {
  try { await ack() } catch {}
  try {
    if (body.user_id !== USER) return
    const name = String(body.command || '').replace(/^\/cc-/, '')
    const rest = String(body.text || '').trim().split(/\s+/).filter(Boolean)
    log('slash', body.command, JSON.stringify(body.text || ''))
    await dispatch(name, rest, body.channel_id)
  } catch (e) { log('slash error', String(e)) }
})

// Interactive components: Approve/Deny buttons and the /cc-new folder picker.
sm.on('interactive', async ({ body, ack }) => {
  try { await ack() } catch {}
  try {
    if (body?.type !== 'block_actions' || body.user?.id !== USER) return
    const action = body.actions?.[0]
    if (!action) return
    if (action.action_id === 'ccnew_folder') {
      const folder = action.selected_option?.value
      if (folder) await spawnNew(body.channel?.id, path.join(codeDir(), folder), ['--dangerously-skip-permissions'])
      return
    }
    if (action.value) {
      const [behavior, rid] = String(action.value).split(':')
      await applyVerdict(rid, behavior, body.channel?.id, body.message?.ts)
    }
  } catch (e) { log('interactive error', String(e)) }
})

// ---- liveness sweep ---------------------------------------------------------
setInterval(async () => {
  for (const s of Object.values(state.sessions)) {
    if (s.pid && !pidAlive(s.pid)) {
      log('sweep: pid dead', s.pid, s.id.slice(0, 8))
      stopPoller(s)
      s.pid = null
      try {
        await clearStatus(s)
        if (s.channel) await post(s.channel, '💤 *Session ended* — write here to resume it')
      } catch (e) {
        if (e?.data?.error === 'is_archived') {
          delete state.channels[s.channel]; delete state.sessions[s.id]
          log('sweep: dropped session with archived channel', s.id.slice(0, 8))
        } else log('sweep post error:', e?.data?.error || String(e))
      }
      saveState(state)
    }
  }
}, 30000)

// ---- boot -------------------------------------------------------------------
;(async () => {
  const r = await web.auth.test()
  log('slack auth ok:', r.team, 'bot', r.user)
  // Ensure existing live sessions also terminate on window close.
  for (const s of Object.values(state.sessions)) {
    if (s.tmux && s.pid && pidAlive(s.pid)) setKillOnClose(s.tmux)
  }
  if (!state.control) {
    try {
      const c = await web.conversations.create({ name: 'claude-code-bridge', is_private: true })
      state.control = c.channel.id
      await web.conversations.invite({ channel: c.channel.id, users: USER })
      await post(c.channel.id, '🤖 *Bridge online.* Type `/cc-` for commands — `/cc-new` to start a session, `/cc-status`, `/cc-help`.')
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
