#!/usr/bin/env node
// ClaudeSlackProxy daemon. Owns the Socket Mode connection and all bridge logic.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import {
  BRIDGE, CONFIG_DIR, log, sleep, loadEnv, loadState, saveState,
  resolveClaudePid, pidAlive, gitInfo, gitStatusText, gitBranch, channelName,
  tmuxSendCommand, tmuxAlive, tmuxKill, tmuxCapture, tmuxInterrupt, tmuxPaste,
  ghosttySpawn, clearKillOnClose, execFile, availableModels, reapGhosttyZombies,
} from './util.mjs'
import { enqueue, mdToMessages, unescapeSlack, escapeText } from './slackout.mjs'

loadEnv()
let USER = process.env.SLACK_USER_ID // unset on fresh installs until /cc-claim
const TEAM = process.env.SLACK_TEAM_ID
const web = new WebClient(process.env.SLACK_BOT_TOKEN)
const state = loadState()
if (!state.perms) state.perms = {} // open permission prompts, survive daemon restarts
if (!state.whitelist) state.whitelist = {} // channel → { userId: name }: collaborators allowed to post
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

// ---- Claude Code binary: version, update, model list ------------------------
const restarting = new Set() // session ids intentionally restarting (suppress the "ended" notice)
function claudeBin() {
  const local = path.join(process.env.HOME, '.local', 'bin', 'claude') // native-install symlink
  return fs.existsSync(local) ? local : 'claude'
}
async function claudeVersion() {
  try { return (await execFile(claudeBin(), ['--version'])).stdout.trim().split(/\s+/)[0] } catch { return '?' }
}
let modelCache = { key: null, list: [] }
async function getModels() {
  const bin = claudeBin()
  let key = bin; try { key = fs.realpathSync(bin) } catch {}
  if (modelCache.key === key) return modelCache.list
  const list = await availableModels(bin)
  if (list.length) modelCache = { key, list } // keyed by version path; refreshes after an update
  return list
}
const PERM_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---- session/channel helpers -----------------------------------------------
function sessionByPid(pid) {
  return Object.values(state.sessions).find(s => s.pid === pid)
}
function sessionByChannel(ch) {
  const sid = state.channels[ch]
  return sid ? state.sessions[sid] : null
}
// ---- collaborators: a per-channel whitelist of Slack users allowed to post ---
const nameCache = new Map()
async function resolveUserName(userId) {
  if (nameCache.has(userId)) return nameCache.get(userId)
  let name = userId
  try {
    const u = (await web.users.info({ user: userId })).user || {}
    name = u.profile?.display_name || u.real_name || u.name || userId
  } catch (e) { log('users.info failed', userId, e?.data?.error || String(e)) }
  nameCache.set(userId, name)
  return name
}
const collaborators = ch => state.whitelist[ch] || {}
const whitelistedName = (ch, userId) => collaborators(ch)[userId] || null
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
  const p = { timer: null, last: '', stopped: false, sawSpinner: false, idle: 0 }
  p.timer = setInterval(async () => {
    if (p.stopped || !session.tmux || !(session.pid && pidAlive(session.pid))) return
    const line = extractSpinner(await tmuxCapture(session.tmux))
    if (p.stopped) return // Stop fired during the capture — don't re-post
    if (line) {
      p.sawSpinner = true; p.idle = 0
      if (line !== p.last) { p.last = line; await setStatus(session, line) }
    } else if (p.sawSpinner && !hasPendingPerm(session) && ++p.idle >= 4) {
      // The spinner vanished for ~12s after a turn was running: the turn ended.
      // Normally the Stop hook finalizes; if it never arrives (a missed hook, or a
      // long/compacted turn), do it here so the response is never silently lost.
      p.stopped = true
      log('poller finalize (Stop hook missing)', session.id.slice(0, 8))
      await finalizeTurn(session)
    }
  }, 3000)
  pollers.set(session.id, p)
}
function stopPoller(session) {
  const p = pollers.get(session.id)
  if (p) { p.stopped = true; clearInterval(p.timer); pollers.delete(session.id) }
}
const hasPendingPerm = session => Object.values(state.perms).some(p => p.channel === session.channel)
// Mirror a turn's final assistant text and clear its live status. Called by the
// Stop hook and, as a fallback, by the poller when a turn ends without a Stop.
// Idempotent: readNewAssistantText advances the read offset, so a second caller
// (whichever of Stop / poller runs later) reads nothing and posts nothing.
async function finalizeTurn(session) {
  stopPoller(session)
  await clearStatus(session)
  if (session.transcript) await waitTranscriptSettle(session.transcript)
  const text = readNewAssistantText(session)
  if (text) await postMd(session.channel, text)
  saveState(state)
}

// Recover live status after a daemon restart. The poller and each status
// message's ts live only in memory, so a restart mid-turn freezes the status —
// the daemon can neither update it nor, on Stop, clear it. On boot we re-adopt:
// if a live session still shows a spinner, find its frozen status message and
// resume the poller on it; if the turn already ended, delete the stale message.
async function findStatusMessage(channel) {
  if (!channel) return null
  try {
    const r = await web.conversations.history({ channel, limit: 15 })
    // Slack returns the emoji as its :gear: shortcode in `text`, not the literal ⚙️.
    return r.messages?.find(m => typeof m.text === 'string' && /^(:gear:|⚙️)/.test(m.text))?.ts || null
  } catch (e) { log('findStatusMessage error', e?.data?.error || String(e)); return null }
}
async function readoptStatus() {
  for (const s of Object.values(state.sessions)) {
    if (!(s.pid && pidAlive(s.pid) && s.tmux && (await tmuxAlive(s.tmux)))) continue
    const spinning = !!extractSpinner(await tmuxCapture(s.tmux))
    const ts = await findStatusMessage(s.channel)
    if (spinning) {
      if (ts) statusTs.set(s.id, ts) // resume editing the existing (frozen) message
      startPoller(s)
      log('re-adopted live turn', s.id.slice(0, 8), ts ? '(resumed status)' : '(fresh status)')
    } else {
      // Idle: nothing to mirror. Re-anchor the read offset to EOF so a stale or
      // lost offset from before the restart doesn't strand mirroring behind, and
      // clear any status left frozen by the restart.
      try { const sz = fs.statSync(s.transcript).size; if (Number.isFinite(sz) && sz !== s.offset) { s.offset = sz; log('re-anchored idle session', s.id.slice(0, 8), 'offset→EOF') } } catch {}
      if (ts) { try { await web.chat.delete({ channel: s.channel, ts }) } catch {} }
    }
  }
  saveState(state)
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
async function onHook(body, ppid, tmux, flags) {
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
  if (flags != null && flags !== '') session.launchFlags = flags
  saveState(state)

  if (ev === 'SessionStart') {
    restarting.delete(sid) // a resumed /cc-update session is up; re-enable the "ended" notice
    resurrectInFlight.delete(sid) // the wake completed; future resurrects are legitimate
    if (session.tmux) clearKillOnClose(session.tmux) // window close must NOT kill the session (Ghostty single-instance cascade)
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
    log('stop hook', session.id.slice(0, 8))
    await finalizeTurn(session)
    return
  }
  if (ev === 'SessionEnd') {
    stopPoller(session)
    await clearStatus(session)
    if (session.channel && !restarting.has(sid)) await post(session.channel, '💤 *Session ended* — write here to resume it')
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

// Rebuild the launch args for a resume: replay the original flags (so
// --dangerously-skip-permissions, --chrome, etc. are preserved), minus any
// resume/continue flags, then add --resume <id>. Sessions launched before flag
// capture fall back to the operator's usual flags (default: --dsp).
function resumeArgs(session) {
  const toks = (session.launchFlags || '').trim().split(/\s+/).filter(Boolean)
  const keep = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t === '--resume' || t === '-r') { i++; continue } // drop --resume <id>
    if (t === '--continue' || t === '-c') continue
    if (t === '--effort') { i++; continue } // drop; re-added below from the live value
    keep.push(t)
  }
  if (!keep.length) keep.push(...(process.env.CCS_RESUME_FLAGS || '--dangerously-skip-permissions').split(/\s+/).filter(Boolean))
  // Claude Code resets runtime effort (set via /effort) on resume, so carry the
  // last-known effort forward as a launch flag (--effort is a valid launch flag).
  const effort = session.effort || sessionMeta.get(session.id)?.effort
  if (effort) keep.push('--effort', effort)
  return [...keep, '--resume', session.id]
}

// /model and /effort now pop a "Change …? Yes / No" confirmation (changing either
// invalidates the prompt cache). Send the command, then confirm the highlighted
// default ("Yes") when the dialog appears; if it never appears, this is a no-op.
async function sendMenuCommand(tmux, cmd) {
  await tmuxSendCommand(tmux, cmd)
  for (let i = 0; i < 5; i++) {
    await sleep(400)
    if (/Yes, switch to|Change (effort|model) level/i.test(await tmuxCapture(tmux))) {
      await execFile('tmux', ['send-keys', '-t', tmux, 'Enter']) // confirm "Yes"
      return
    }
  }
}

// --resume is scoped to the launch dir's project slug (~/.claude/projects/<slug>/),
// so we must launch from the directory whose slug holds this session's transcript.
// The recorded cwd can drift — claude cd's into a subdir and the statusline moves
// session.cwd there — which makes --resume look under the wrong slug and fail. Find
// the dir that actually holds the transcript and re-anchor to it.
function resumeCwd(session) {
  if (session.transcript && fs.existsSync(session.transcript)) return session.cwd
  const base = path.join(process.env.HOME, '.claude', 'projects')
  try {
    for (const d of fs.readdirSync(base)) {
      const t = path.join(base, d, session.id + '.jsonl')
      if (fs.existsSync(t)) { session.transcript = t; return '/' + d.replace(/^-/, '').replace(/-/g, '/') }
    }
  } catch {}
  return session.cwd
}

// sid → ts of a resurrect currently materializing. Guards against stacked spawns:
// messages that arrive while claude is still starting used to trigger fresh spawns
// (and fresh "Waking…" posts) every time. Cleared by SessionStart, or after 90s.
const resurrectInFlight = new Map()

async function resurrect(session, text) {
  const inflight = resurrectInFlight.get(session.id)
  if (inflight && Date.now() - inflight < 90000) return // already waking; message is queued
  resurrectInFlight.set(session.id, Date.now())
  let up = false
  try {
    const anchored = resumeCwd(session)
    if (anchored !== session.cwd) { log('resume cwd re-anchored', session.id.slice(0, 8), session.cwd, '→', anchored); session.cwd = anchored; saveState(state) }
    // Claude Code scopes --resume to the cwd's project, so the folder must exist at
    // its original path. If it's gone (e.g. a deleted worktree), recreate it empty —
    // the transcript in ~/.claude/projects survives, so the conversation resumes.
    if (!fs.existsSync(session.cwd)) {
      try {
        fs.mkdirSync(session.cwd, { recursive: true })
        await post(session.channel, `⚠️ Folder \`${session.cwd}\` was gone — recreated it empty and resuming there. The conversation is intact; files from the original folder are not.`)
      } catch (e) {
        return post(session.channel, `❌ Can't resume — folder \`${session.cwd}\` is gone and couldn't be recreated (${e?.code || e}). The transcript is preserved; resume manually with \`claude --resume ${session.id}\` from a valid directory.`)
      }
    }
    await post(session.channel, '⏳ *Waking this session up on the Mac…*')
    const args = resumeArgs(session)
    // Spawn and VERIFY the terminal actually materialized (tmux session appears).
    // A wedged Ghostty fails silently — the window never initializes and nothing
    // reports it. On failure: kill the dead attempt, reap aged windowless
    // instances (the usual cause), and retry once before telling the user.
    for (let attempt = 1; attempt <= 2; attempt++) {
      await reapGhosttyZombies()
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
      for (let i = 0; i < 24 && !up; i++) { await sleep(500); up = await tmuxAlive(tmuxName) }
      if (up) return // SessionStart clears the in-flight guard and flushes the queue
      log('spawn did not materialize', { attempt, tmuxName })
      await execFile('pkill', ['-f', tmuxName]).catch(() => {}) // kill the failed young instance
    }
    await post(session.channel,
      '⚠️ *The terminal window never initialized* (Ghostty looks wedged) — I cleaned up and retried without luck. ' +
      'Quit Ghostty on the Mac (or wait a minute) and write here again; your message is queued.')
  } finally {
    if (!up) resurrectInFlight.delete(session.id)
  }
}
const pendingBySid = new Map()

// /cc-update: stop this session's Claude, update the CLI if a newer build exists,
// then resume the same conversation with identical launch flags.
async function updateAndRestart(session) {
  const before = await claudeVersion()
  await post(session.channel, `🔄 *Restarting ${path.basename(session.cwd)}* — stopping Claude, checking for updates, then resuming with the same flags.`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session); await clearStatus(session)
  session.pid = null; saveState(state)
  await sleep(1500) // let the old process fully exit before the binary is swapped
  let note = ''
  try {
    const { stdout, stderr } = await execFile(claudeBin(), ['update'], { timeout: 180000 })
    note = (stdout + '\n' + stderr).split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
  } catch (e) { note = `error: ${e?.stderr?.trim() || e?.message || e}` }
  const after = await claudeVersion()
  const ver = before !== after ? `updated \`${before}\` → \`${after}\``
    : /error|fail/i.test(note) ? `⚠️ update check failed — staying on \`${after}\` (${note.slice(0, 120)})`
    : `already on the latest (\`${after}\`)`
  await post(session.channel, `📦 Claude Code ${ver}. Resuming the conversation…`)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000) // safety net if the resume never starts
}

async function handleSlackMessage(channel, text, sender) {
  const trimmed = text.trim()

  // Collaborators may only send prompts into a LIVE session: no permission
  // verdicts, no commands, and no resurrection (that would spawn a terminal on
  // the host). The prompt is attributed so the transcript shows who sent it.
  if (sender) {
    const session = sessionByChannel(channel)
    if (!session) { log('collab msg in unmapped channel, ignored', channel); return }
    if (!(session.pid && pidAlive(session.pid))) {
      return post(channel, `💤 Session is dormant — <@${sender.id}>’s message wasn’t delivered. Only the owner can resume it.`)
    }
    return injectText(session, `[Slack collaborator ${sender.name}]\n${trimmed}`)
  }

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
async function handleAttachments(channel, caption, files, sender) {
  const session = sessionByChannel(channel)
  if (!session) { log('attachment in unmapped channel, ignored', channel); return }
  if (sender && !(session.pid && pidAlive(session.pid))) {
    return post(channel, `💤 Session is dormant — <@${sender.id}>’s attachment wasn’t delivered. Only the owner can resume it.`)
  }
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
  await injectText(session, sender ? `[Slack collaborator ${sender.name}]\n${body}` : body)
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
  await reapGhosttyZombies() // windowless-instance pileup breaks new windows
  await ghosttySpawn({ cwd, args: flags, title: `ccs ${path.basename(cwd)}`, tmuxName, autoConsent: true })
  let up = false
  for (let i = 0; i < 24 && !up; i++) { await sleep(500); up = await tmuxAlive(tmuxName) }
  if (!up) await post(channel, '⚠️ *The terminal window never initialized* (Ghostty looks wedged). Quit Ghostty on the Mac and try `/cc-new` again.')
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

// Interactive collaborator panel: a user-picker to add + a Remove button per
// current collaborator. Rendered under /cc-status in a session channel.
async function collabBlocks(channel) {
  const ids = Object.keys(collaborators(channel))
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: '*👥 Collaborators* — Slack users allowed to send prompts to this session (their prompts are labelled in the transcript)' },
    accessory: { type: 'users_select', action_id: 'collab_add', placeholder: { type: 'plain_text', text: 'Add a collaborator…' } },
  }]
  if (!ids.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_None yet — pick someone above to let them post here._' }] })
  } else {
    for (const uid of ids) {
      blocks.push({
        type: 'section', text: { type: 'mrkdwn', text: `• <@${uid}>` },
        accessory: { type: 'button', text: { type: 'plain_text', text: 'Remove' }, style: 'danger', value: `collab_rm:${uid}`, action_id: 'collab_rm' },
      })
    }
  }
  return blocks
}
async function refreshCollabPanel(body) {
  try {
    await web.chat.update({ channel: body.channel.id, ts: body.message.ts, text: 'Collaborators', blocks: await collabBlocks(body.channel.id) })
  } catch (e) { log('collab panel update failed', e?.data?.error || String(e)) }
}

// ---- usage reporting (ccusage) ----------------------------------------------
// ccusage (bundled as a dependency) scans the local Claude Code transcripts and
// prices them. Sessions are keyed by session id; a project's ids are exactly the
// .jsonl basenames in its ~/.claude/projects/<slug>/ dir, which the daemon
// already knows via each session's transcript path.
async function ccusageJson(sub) {
  const bin = path.join(BRIDGE, 'node_modules', '.bin', 'ccusage')
  const { stdout } = await execFile(bin, [sub, '--json'], { timeout: 90000, maxBuffer: 32 << 20 })
  return JSON.parse(stdout)
}
const fmtTok = n => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n))
const fmtUsd = n => n == null ? '—' : '$' + n.toFixed(2)
const shortModel = m => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '')

// ---- plan rate limits (from the statusline feed) -----------------------------
let rateLimits = null // { at, buckets: { five_hour: {used_percentage, resets_at}, seven_day: {...}, ... } }
const LIMIT_LABELS = { five_hour: 'Current session (5h)', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus' }
const limitBar = pct => '▓'.repeat(Math.min(10, Math.round(pct / 10))).padEnd(10, '░') + ' ' + Math.round(pct) + '%'
function fmtReset(epoch) {
  if (!epoch) return '—'
  const d = new Date(epoch * 1000), now = new Date()
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? `today ${time}`
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ` ${time}`
}
function limitLines() {
  if (!rateLimits || Date.now() - rateLimits.at > 15 * 60000) return null
  return Object.entries(rateLimits.buckets)
    .filter(([, v]) => v && typeof v === 'object' && 'used_percentage' in v)
    .map(([k, v]) => ({ label: LIMIT_LABELS[k] || k.replace(/_/g, ' '), pct: v.used_percentage, resets: fmtReset(v.resets_at) }))
}
function usageLimits(channel) {
  const lines = limitLines()
  if (!lines) return post(channel, 'No fresh limit data — it streams from live sessions. Write in any session channel, then retry.')
  return postMd(channel,
    `*Plan limits* — live from Claude Code\n` +
    `| Limit | Used | Resets |\n|---|---|---|\n` +
    lines.map(l => `| ${l.label} | ${limitBar(l.pct)} | ${l.resets} |`).join('\n'))
}
const limitFooter = () => {
  const lines = limitLines()
  return lines ? '\n_' + lines.map(l => `${l.label}: ${Math.round(l.pct)}% (resets ${l.resets})`).join(' · ') + '_' : ''
}

async function usageDays(channel, nArg) {
  const n = Math.min(Math.max(parseInt(nArg, 10) || 7, 1), 14)
  const j = await ccusageJson('daily')
  const days = (j.daily || []).slice(-n)
  if (!days.length) return post(channel, 'No usage data yet.')
  const sum = k => days.reduce((a, d) => a + (d[k] || 0), 0)
  const rows = days.map(d => {
    const models = [...new Set((d.modelBreakdowns || []).map(b => shortModel(b.modelName)))].join(', ') || '—'
    return `| ${d.period.slice(5)} | ${models} | ${fmtTok(d.inputTokens)} | ${fmtTok(d.outputTokens)} | ${fmtTok(d.cacheCreationTokens)} | ${fmtTok(d.cacheReadTokens)} | ${fmtTok(d.totalTokens)} | ${fmtUsd(d.totalCost)} |`
  })
  return postMd(channel,
    `*Usage by day* — last ${days.length} day(s), all projects\n` +
    `| Day | Models | In | Out | Cache W | Cache R | Total | Cost |\n|---|---|---|---|---|---|---|---|\n` +
    rows.join('\n') + '\n' +
    `| Σ | | ${fmtTok(sum('inputTokens'))} | ${fmtTok(sum('outputTokens'))} | ${fmtTok(sum('cacheCreationTokens'))} | ${fmtTok(sum('cacheReadTokens'))} | ${fmtTok(sum('totalTokens'))} | ${fmtUsd(sum('totalCost'))} |` +
    limitFooter())
}

async function usageModels(channel) {
  const j = await ccusageJson('daily')
  const agg = {}
  for (const d of j.daily || []) for (const b of d.modelBreakdowns || []) {
    const a = agg[b.modelName] ??= { in: 0, out: 0, cw: 0, cr: 0, cost: 0 }
    a.in += b.inputTokens || 0; a.out += b.outputTokens || 0
    a.cw += b.cacheCreationTokens || 0; a.cr += b.cacheReadTokens || 0; a.cost += b.cost || 0
  }
  const rows = Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost).map(([m, a]) =>
    `| ${shortModel(m)} | ${fmtTok(a.in)} | ${fmtTok(a.out)} | ${fmtTok(a.cw)} | ${fmtTok(a.cr)} | ${fmtUsd(a.cost)} |`)
  if (!rows.length) return post(channel, 'No usage data yet.')
  return postMd(channel,
    `*Usage by model* — all time, all projects\n` +
    `| Model | In | Out | Cache W | Cache R | Cost |\n|---|---|---|---|---|---|\n` + rows.join('\n'))
}

async function usageReport(channel) {
  const session = channel !== state.control ? sessionByChannel(channel) : null
  if (session) {
    const dir = path.dirname(session.transcript || '.')
    let ids = []
    try { ids = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)) } catch {}
    if (!ids.length) return post(channel, 'No transcripts found for this project yet.')
    const j = await ccusageJson('session')
    const rows = (j.session || []).filter(r => ids.includes(r.period))
    if (!rows.length) return post(channel, 'ccusage has no data for this project yet.')
    const cur = rows.find(r => r.period === session.id)
    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0)
    const models = [...new Set(rows.flatMap(r => r.modelsUsed || []))].join(' · ') || '—'
    return postMd(channel,
      `*Usage — ${path.basename(session.cwd)}*\n` +
      `| Scope | Tokens | Cost |\n|---|---|---|\n` +
      `| This session (${session.id.slice(0, 8)}) | ${fmtTok(cur?.totalTokens)} | ${fmtUsd(cur?.totalCost)} |\n` +
      `| Project, all sessions (${rows.length}) | ${fmtTok(sum('totalTokens'))} | ${fmtUsd(sum('totalCost'))} |\n` +
      `_Models: ${models}_` + limitFooter())
  }
  // control channel (or any unmapped channel): aggregate across everything
  const j = await ccusageJson('daily')
  const days = j.daily || []
  const month = new Date().toISOString().slice(0, 7)
  const msum = k => days.filter(d => String(d.period).startsWith(month)).reduce((a, r) => a + (r[k] || 0), 0)
  const t = j.totals || {}
  const rows7 = days.slice(-7).map(d => `| ${d.period} | ${fmtTok(d.totalTokens)} | ${fmtUsd(d.totalCost)} |`).join('\n')
  return postMd(channel,
    `*Usage — all projects*\n` +
    `| Day | Tokens | Cost |\n|---|---|---|\n${rows7}\n` +
    `| This month | ${fmtTok(msum('totalTokens'))} | ${fmtUsd(msum('totalCost'))} |\n` +
    `| All time | ${fmtTok(t.totalTokens)} | ${fmtUsd(t.totalCost)} |` + limitFooter())
}

// Command dispatch for the native /cc-* slash commands.
async function dispatch(name, rest, channel) {
  if (name === 'help') {
    return post(channel,
      '*Commands* — use `/cc-<name>` (autocompletes as you type `/cc-`)\n' +
      '`/cc-new [folder] [--dsp] [--chrome]` — start a session (no arg = pick a project)\n' +
      '`/cc-model [m]` · `/cc-effort [e]` — show or set (no arg lists available models with versions)\n' +
      '`/cc-update` — update Claude Code & restart this session with the same flags\n' +
      '`/cc-stop` — interrupt the running turn\n' +
      '`/cc-status` — session info + manage collaborators here, or list all sessions from control\n' +
      '`/cc-usage [days [n] | models | limits]` — usage: project here / aggregate in control; `days` = per-day sheet, `models` = per-model, `limits` = plan limits (5h/weekly %)\n' +
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
      await postMd(channel,
        `*Session ${session.id.slice(0, 8)}* — ${alive ? '🟢 active' : '💤 dormant'}\n` +
        `| Field | Value |\n|---|---|\n` +
        `| Folder | ${session.cwd} |\n` +
        `| Branch | ${branch || '—'}${worktree ? ` · wt:${worktree}` : ''} |\n` +
        `| Model | ${meta.model || readModel(session) || '—'} |\n` +
        `| Effort | ${meta.effort || '—'} |\n` +
        `| Changes | ${changes} |` +
        (gs ? '\n```\n' + gs.slice(0, 1200) + '\n```' : ''))
      await web.chat.postMessage({ channel, text: 'Collaborators', blocks: await collabBlocks(channel) })
      return
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
      if (name === 'model') {
        const cur = meta.model || readModel(session) || 'unknown'
        const models = await getModels()
        if (models.length) {
          const rows = models.map(m => `| \`${m.alias}\` | ${m.name} | \`${m.id}\` |`).join('\n')
          return postMd(channel, `*Model* — current: \`${cur}\`\nSet with \`/cc-model <alias>\` (or a full id):\n| Alias | Model | Full id |\n|---|---|---|\n${rows}`)
        }
        return post(channel, `*model*: \`${cur}\`\nSet with \`/cc-model <value>\`  (sonnet · opus · haiku · fable)`)
      }
      return post(channel, `*effort*: \`${meta.effort || 'unknown'}\`\nSet with \`/cc-effort <value>\`  (low · medium · high · max)`)
    }
    if (!(session.pid && pidAlive(session.pid))) return post(channel, 'Session not active — send a message first to wake it.')
    const val = rest.join(' ')
    await sendMenuCommand(session.tmux, `/${name} ${val}`)
    sessionMeta.set(session.id, { ...meta, [name]: val })
    if (name === 'effort') { session.effort = val; saveState(state) } // persist so resume restores it
    return post(channel, `✅ ${name} → \`${val}\``)
  }
  if (name === 'stop') {
    const session = sessionByChannel(channel)
    if (!session?.tmux || !(session.pid && pidAlive(session.pid))) return post(channel, 'No active session here to interrupt.')
    await tmuxInterrupt(session.tmux)
    return post(channel, '⎋ *Interrupted* the running turn.')
  }
  if (name === 'usage') {
    const sub = (rest[0] || '').toLowerCase()
    if (sub === 'limits') return usageLimits(channel) // instant — no transcript scan
    await post(channel, '⏳ Crunching transcripts…')
    try {
      if (sub === 'days' || sub === 'daily') return await usageDays(channel, rest[1])
      if (sub === 'models') return await usageModels(channel)
      return await usageReport(channel)
    } catch (e) { log('usage error', String(e)); return post(channel, `⚠️ ccusage failed: ${String(e?.message || e).slice(0, 200)}`) }
  }
  if (name === 'update' || name === 'restart') {
    const session = sessionByChannel(channel)
    if (!session) return post(channel, 'Use `/cc-update` in a session channel — it updates Claude Code and restarts the session with the same flags.')
    return updateAndRestart(session)
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
    try { await onHook(JSON.parse(body), url.searchParams.get('ppid'), url.searchParams.get('tmux'), req.headers['x-ccs-flags']) }
    catch (e) { log('hook error', String(e)) }
    return
  }
  if (url.pathname === '/statusline' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      const j = JSON.parse(body)
      // Plan rate limits (5h session %, weekly %, reset times) ride along on every
      // statusline tick. They're account-wide, so one fresh copy serves all views.
      if (j.rate_limits) rateLimits = { at: Date.now(), buckets: j.rate_limits }
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
          if (j.effort?.level && session.effort !== j.effort.level) { session.effort = j.effort.level; saveState(state) } // persist for resume
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
  // The owner is always trusted; a whitelisted collaborator may post prompts too.
  const isOwner = event.user === USER
  const name = isOwner ? null : whitelistedName(event.channel, event.user)
  if (!isOwner && !name) return
  const sender = isOwner ? null : { id: event.user, name }
  try {
    const text = unescapeSlack(event.text || '')
    if (event.files?.length) await handleAttachments(event.channel, text, event.files, sender)
    else await handleSlackMessage(event.channel, text, sender)
  } catch (e) { log('slack msg error', String(e)) }
})

// Native /cc-* slash commands (registered in the manifest, delivered over the socket).
// First-run ownership claim. Fresh installs start with no SLACK_USER_ID — the
// installer no longer asks anyone to dig their member ID out of their profile.
// The first person to run /cc-claim becomes the owner, persisted to the config
// env; until then the daemon trusts nobody and does nothing else.
function persistOwner(uid) {
  const f = path.join(CONFIG_DIR, 'env')
  let env = ''
  try { env = fs.readFileSync(f, 'utf8') } catch {}
  env = /^SLACK_USER_ID=/m.test(env)
    ? env.replace(/^SLACK_USER_ID=.*/m, `SLACK_USER_ID=${uid}`)
    : env.trimEnd() + `\nSLACK_USER_ID=${uid}\n`
  fs.writeFileSync(f, env, { mode: 0o600 })
}
// Reply visibly to a slash command in channels the bot may not be a member of.
async function respondEphemeral(body, text) {
  if (!body?.response_url) return
  try {
    await fetch(body.response_url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, response_type: 'ephemeral' }),
    })
  } catch {}
}

sm.on('slash_commands', async ({ body, ack }) => {
  try { await ack() } catch {}
  try {
    const name = String(body.command || '').replace(/^\/cc-/, '')
    if (!USER) {
      if (name !== 'claim') return respondEphemeral(body, 'This bridge is unclaimed — run `/cc-claim` to become its owner.')
      USER = body.user_id
      persistOwner(USER)
      log('owner claimed', USER)
      await respondEphemeral(body, '👑 You own this bridge now. Check your new private #claude-code-bridge channel.')
      if (state.control) {
        try { await web.conversations.invite({ channel: state.control, users: USER }) } catch {}
        await post(state.control, `👑 <@${USER}> claimed this bridge. Type \`/cc-\` for commands — \`/cc-new\` starts a session, \`/cc-help\` lists everything.`).catch(() => {})
      }
      return
    }
    if (name === 'claim') return respondEphemeral(body, body.user_id === USER ? 'You already own this bridge.' : 'This bridge already has an owner.')
    if (body.user_id !== USER) return
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
    if (action.action_id === 'collab_add') {
      const uid = action.selected_user, channel = body.channel?.id
      if (uid && channel && uid !== USER) {
        const name = await resolveUserName(uid)
        state.whitelist[channel] = { ...collaborators(channel), [uid]: name }
        saveState(state)
        log('collab add', uid, JSON.stringify(name), '→', channel)
        await refreshCollabPanel(body)
        await post(channel, `✅ <@${uid}> can now send prompts here — labelled *[Slack collaborator ${name}]* in the transcript.`)
      }
      return
    }
    if (action.action_id === 'collab_rm') {
      const uid = String(action.value || '').split(':')[1], channel = body.channel?.id
      if (uid && channel && collaborators(channel)[uid]) {
        delete state.whitelist[channel][uid]
        if (!Object.keys(state.whitelist[channel]).length) delete state.whitelist[channel]
        saveState(state)
        log('collab remove', uid, '→', channel)
        await refreshCollabPanel(body)
        await post(channel, `🚫 Removed <@${uid}> — they can no longer post here.`)
      }
      return
    }
    if (action.value) {
      const [behavior, rid] = String(action.value).split(':')
      await applyVerdict(rid, behavior, body.channel?.id, body.message?.ts)
    }
  } catch (e) { log('interactive error', String(e)) }
})

// ---- bridge self-update ------------------------------------------------------
// Every install is a git clone running under launchd with KeepAlive, so keeping
// users current is: fast-forward the clone, refresh deps if package.json moved,
// then exit — launchd restarts the daemon on the new code (sessions keep running;
// restart recovery re-adopts them). Checks at boot and every 6h.
// Opt out with CCS_AUTO_UPDATE=0 in ~/.config/ccs/env.
const pkgVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8')).version } catch { return '?' } }
async function selfUpdate(trigger) {
  if (process.env.CCS_AUTO_UPDATE === '0') return
  const git = (...a) => execFile('git', ['-C', BRIDGE, ...a], { timeout: 60000 })
  try { await git('rev-parse', '--git-dir') } catch { return } // not a git install
  try { await git('fetch', '--quiet', 'origin') } catch { log('self-update: fetch failed (offline?)'); return }
  let ahead = 0, behind = 0
  try {
    const { stdout } = await git('rev-list', '--left-right', '--count', 'HEAD...@{u}')
    ;[ahead, behind] = stdout.trim().split(/\s+/).map(Number)
  } catch { if (trigger === 'boot') log('self-update: no upstream branch — skipping'); return }
  if (!behind) { if (trigger === 'boot') log(`self-update: up to date (v${pkgVersion()})`); return }
  if ((await git('status', '--porcelain')).stdout.trim()) { log(`self-update: ${behind} commit(s) behind but working tree dirty — skipping (dev checkout?)`); return }
  if (ahead) { log('self-update: local commits not on origin — skipping'); return }
  const before = pkgVersion()
  const pkgBefore = fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8')
  try { await git('merge', '--ff-only', '@{u}') } catch (e) { log('self-update: fast-forward failed', e?.stderr || String(e)); return }
  if (fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8') !== pkgBefore) {
    log('self-update: package.json changed — refreshing dependencies')
    try { await execFile('npm', ['ci', '--omit=dev'], { cwd: BRIDGE, timeout: 180000 }) }
    catch { await execFile('npm', ['install', '--omit=dev'], { cwd: BRIDGE, timeout: 180000 }).catch(e => log('self-update: npm install failed', String(e))) }
  }
  const after = pkgVersion()
  log(`self-update: v${before} → v${after}; restarting when idle`)
  for (let i = 0; i < 120 && pollers.size; i++) await sleep(5000) // prefer restarting between turns (≤10 min)
  if (state.control) await post(state.control, `⬆️ *Bridge updated* v${before} → v${after} — restarting the daemon. Sessions keep running.`).catch(() => {})
  setTimeout(() => process.exit(0), 800) // flush the post; launchd (KeepAlive) brings us back on the new code
}
setInterval(() => selfUpdate('interval').catch(e => log('self-update error', String(e))), 6 * 3600 * 1000)

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

// ---- terminal-close → terminate, debounced ----------------------------------
// Restores 0.2.1's "close the window to end the session" — but safely. A
// single-instance Ghostty spawn briefly detaches every other window's tmux client
// (they re-attach in <1s); reacting to that instantaneous detach is what cascaded
// into killing everything. So instead of a tmux client-detached hook, the daemon
// watches client attachment and ends a session only once its window has stayed
// gone for CLOSE_GRACE_MS — well past any transient spawn blip.
const CLOSE_GRACE_MS = 8000
const winGoneSince = new Map() // sid → ts its window went missing
const winSawWindow = new Set() // sids we've seen with a live window at least once
setInterval(async () => {
  for (const s of Object.values(state.sessions)) {
    if (!(s.pid && pidAlive(s.pid) && s.tmux && (await tmuxAlive(s.tmux)))) { winGoneSince.delete(s.id); winSawWindow.delete(s.id); continue }
    let n = -1
    try { n = (await execFile('tmux', ['list-clients', '-t', s.tmux])).stdout.split('\n').filter(Boolean).length } catch {}
    if (n < 0) continue                       // tmux hiccup — don't act on unknown state
    if (n > 0) { winSawWindow.add(s.id); winGoneSince.delete(s.id); continue }
    if (!winSawWindow.has(s.id)) continue     // still opening its first window
    if (!winGoneSince.has(s.id)) { winGoneSince.set(s.id, Date.now()); continue }
    if (Date.now() - winGoneSince.get(s.id) < CLOSE_GRACE_MS) continue // maybe a spawn blip; wait it out
    log('terminal closed → ending session', s.id.slice(0, 8))
    winGoneSince.delete(s.id); winSawWindow.delete(s.id)
    if (s.tmux) await tmuxKill(s.tmux)
    if (s.pid && pidAlive(s.pid)) { try { process.kill(s.pid) } catch {} }
    stopPoller(s); await clearStatus(s)
    s.pid = null; saveState(state)
    if (s.channel && !restarting.has(s.id)) { try { await post(s.channel, '💤 *Session ended* (terminal closed) — write here to resume it') } catch {} }
  }
}, 3000)

// ---- boot -------------------------------------------------------------------
;(async () => {
  const r = await web.auth.test()
  log('slack auth ok:', r.team, 'bot', r.user)
  // Remove any old client-detached → kill-session hooks from existing live sessions,
  // so a Ghostty single-instance window teardown can no longer cascade-kill them.
  for (const s of Object.values(state.sessions)) {
    if (s.tmux && s.pid && pidAlive(s.pid)) clearKillOnClose(s.tmux)
  }
  if (!state.control) {
    try {
      const c = await web.conversations.create({ name: 'claude-code-bridge', is_private: true })
      state.control = c.channel.id
      if (USER) { // fresh installs are unclaimed; /cc-claim invites the owner later
        await web.conversations.invite({ channel: c.channel.id, users: USER })
        await post(c.channel.id, '🤖 *Bridge online.* Type `/cc-` for commands — `/cc-new` to start a session, `/cc-status`, `/cc-help`.')
      }
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
  await readoptStatus() // recover live status for turns that were mid-flight on restart
  selfUpdate('boot').catch(e => log('self-update error', String(e)))
})().catch(e => { log('BOOT FAILED', e); process.exit(1) })
