#!/usr/bin/env node
// Slack Agent Bridge daemon. Owns the Socket Mode connection and bridge logic.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import {
  BRIDGE, CONFIG_DIR, log, sleep, loadEnv, loadState, saveState,
  resolveClaudePid, resolveAgentPid, pidAlive, gitInfo, gitStatusText, gitBranch, channelName,
  tmuxSendCommand, tmuxAlive, tmuxKill, tmuxCapture, tmuxInterrupt, tmuxPaste,
  ghosttySpawn, clearKillOnClose, execFile, availableModels, reapGhosttyZombies, tmuxTitle, safeAccount,
  requestBridgeWindow,
} from './util.mjs'
import { enqueue, mdToMessages, unescapeSlack, escapeText } from './slackout.mjs'
import {
  CODEX_DANGEROUS_FLAG, CODEX_EFFORTS, acceptHookSettings, allowedFlags,
  codexFlagsWithoutInitialPrompt, codexPermissionDecision, defaultNewFlagsFor, displayFlagsFor,
  isPathWithin, isSupersededHook, normalizeLaunchFlag, normalizeProvider, parseSlackCommand,
  providerCommand, providerLabel, providerOf, resolveCodexEffort, resumeArgsFor, slackCommand,
} from './providers.mjs'
import { CONTROL_CHANNEL_NAME, findControlChannel, prunePermissionsOnBoot } from './identity.mjs'

loadEnv()
let USER = process.env.SLACK_USER_ID // unset on fresh installs until /cc-claim
const TEAM = process.env.SLACK_TEAM_ID
const web = new WebClient(process.env.SLACK_BOT_TOKEN)
const state = loadState()
if (!state.perms) state.perms = {} // open permission prompts, survive daemon restarts
if (!state.whitelist) state.whitelist = {} // channel → { userId: name }: collaborators allowed to post
if (!state.channelTmux) state.channelTmux = {} // channel → tmux name last seen owning it (rebinding aid)
const BOOT_TS = Date.now()

// A Codex permission request is a held HTTP response and cannot survive a daemon
// restart. Claude requests use MCP and remain recoverable only if their PID is
// still alive. Prune dead entries so status/pollers never wait on stale prompts.
if (prunePermissionsOnBoot(state.perms, pidAlive)) saveState(state)

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
// ---- Claude Code binary: version, update, model list ------------------------
const restarting = new Set() // session ids intentionally restarting (suppress the "ended" notice)
function claudeBin() {
  const local = path.join(process.env.HOME, '.local', 'bin', 'claude') // native-install symlink
  return fs.existsSync(local) ? local : 'claude'
}
async function claudeVersion() {
  try { return (await execFile(claudeBin(), ['--version'])).stdout.trim().split(/\s+/)[0] } catch { return '?' }
}
function codexBin() {
  const homebrew = '/opt/homebrew/bin/codex'
  return fs.existsSync(homebrew) ? homebrew : 'codex'
}
async function codexVersion() {
  try {
    const out = (await execFile(codexBin(), ['--version'])).stdout.trim()
    return out.match(/\b\d+\.\d+\.\d+\b/)?.[0] || out || '?'
  } catch { return '?' }
}
const agentVersion = provider => provider === 'codex' ? codexVersion() : claudeVersion()
let modelCache = { key: null, list: [] }
async function getModels() {
  const bin = claudeBin()
  let key = bin; try { key = fs.realpathSync(bin) } catch {}
  if (modelCache.key === key) return modelCache.list
  const list = await availableModels(bin)
  if (list.length) modelCache = { key, list } // keyed by version path; refreshes after an update
  return list
}
let codexModelCache = null
async function getCodexModels() {
  if (codexModelCache) return codexModelCache
  try {
    const { stdout } = await execFile(codexBin(), ['debug', 'models', '--bundled'], {
      timeout: 15000, maxBuffer: 32 << 20,
    })
    const parsed = JSON.parse(stdout)
    codexModelCache = (parsed.models || []).filter(m => m.visibility !== 'hide').map(m => ({
      alias: m.slug, id: m.slug, name: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map(e => e.effort),
    }))
    return codexModelCache
  } catch (e) {
    log('codex model catalog unavailable', String(e?.message || e))
    return []
  }
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
  // A binding can be lost (state edited out from under the daemon, a botched
  // migration, a manual repair). Before minting a duplicate channel for a
  // terminal that already has one, reclaim it — a terminal maps to one channel.
  const prior = session.tmux && Object.entries(state.channelTmux).find(([, t]) => t === session.tmux)?.[0]
  if (prior && !sessionByChannel(prior)) {
    try {
      const info = await web.conversations.info({ channel: prior })
      if (!info.channel?.is_archived) {
        session.channel = prior
        state.channels[prior] = session.id
        saveState(state)
        log('reclaimed channel', prior, 'for', session.id.slice(0, 8), 'via terminal', session.tmux)
        await post(prior, '🔄 *Reconnected* — this channel is bound to the session again.')
        return prior
      }
    } catch (e) { log('channel reclaim check failed', e?.data?.error || String(e)) }
  }
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
  const provider = providerOf(session)
  await post(ch, `🟢 *Session started*\n\`${session.cwd}\`\nBranch: \`${branch || '—'}\` · Session \`${session.id.slice(0, 8)}\`` +
    (provider === 'codex' ? ` · Provider: *${providerLabel(provider)}*` : ''))
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
  // Fall back to persisted values — the in-memory meta is empty right after a
  // daemon restart, and pushing a degraded topic would wipe model/effort from
  // the channel (and the window title) until the session next reports in.
  const prettify = m => m ? String(m).replace(/^claude-/, '').replace(/-(\d)/g, ' $1').replace(/^\w/, c => c.toUpperCase()) : m
  const model = meta.model || session.model || prettify(readModel(session))
  const effort = meta.effort || session.effort
  const topic = [
    session.cwd,
    branch || 'no-branch',
    session.worktree ? 'wt:' + session.worktree : '',
    model, effort,
  ].filter(Boolean).join(' · ')
  if (topic === lastTopic.get(session.channel)) return
  lastTopic.set(session.channel, topic)
  if (session.tmux) tmuxTitle(session.tmux, topic) // window title mirrors the channel topic
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
// ---- interactive question forms → Slack --------------------------------------
// Claude Code can pause a turn on an interactive question (numbered options,
// sometimes a multi-tab wizard ending in a Submit screen). In the terminal a
// digit keypress selects AND advances; over Slack the turn just looks stalled.
// Detect the form in the pane, mirror it as buttons, and map answers back to
// keystrokes. Every screen — including "Ready to submit?" — is uniformly
// "question + numbered options", so one mechanism drives the whole wizard.
const qforms = new Map() // sid → { ts, hash, options: [{n, label}], at }
function extractQuestionForm(pane) {
  const lines = pane.split('\n')
  const opts = [], optIdx = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/)
    if (m && !opts.some(o => o.n === Number(m[2]))) { opts.push({ n: Number(m[2]), label: m[3] }) ; optIdx.push(i) }
  }
  if (opts.length < 2) return null
  // Real forms (unlike numbered lists in prose) have a select footer, a tab bar,
  // or a ❯ highlight on an option line.
  const signature = /Enter to select/i.test(pane) || /[☒☐✔].*[☒☐✔]/.test(pane) || optIdx.some(i => /^\s*❯/.test(lines[i]))
  if (!signature) return null
  opts.sort((a, b) => a.n - b.n)
  // Question: the non-separator lines directly above the first option (keeps
  // review bullets like "● …" / "→ …"), capped for sanity.
  const q = []
  for (let i = optIdx[0] - 1; i >= 0 && q.length < 8; i--) {
    const t = lines[i].trim()
    if (/^[─-]{5,}$/.test(t)) { if (q.length) break; continue }
    if (!t || /^[←→]/.test(t) || /Enter to select/i.test(t)) break
    q.unshift(t)
  }
  const question = q.join('\n').trim() || 'Claude asks:'
  const planPath = (pane.match(/(~|\/Users\/[^\s]+)\/\.claude\/plans\/[\w.-]+\.md/) || [])[0] || null
  return { question, options: opts, planPath, hash: question + '|' + opts.map(o => o.n + o.label).join('|') }
}
async function relayQuestionForm(session, form) {
  const prev = qforms.get(session.id)
  if (prev && prev.hash === form.hash) return // unchanged screen
  if (form.planPath && prev?.planFor !== form.hash) {
    try {
      const pf = form.planPath.replace(/^~/, process.env.HOME)
      const md = fs.readFileSync(pf, 'utf8')
      await postMd(session.channel, `📋 *Claude's plan* (\`${path.basename(pf)}\`):\n\n${md}`)
    } catch (e) { log('plan relay failed', String(e?.message || e)) }
  }
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `❓ *Claude asks:*\n${escapeText(form.question).slice(0, 2800)}` } },
    { type: 'actions', block_id: `qform_${session.id.slice(0, 8)}`, elements: form.options.slice(0, 10).map(o => ({
      type: 'button', text: { type: 'plain_text', text: `${o.n}. ${o.label}`.slice(0, 75) }, action_id: `qform_${o.n}`, value: `qform:${session.id}:${o.n}`,
    })) },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'tap an option — or reply with just the number' }] },
  ]
  let ts = prev?.ts
  try {
    if (ts) await web.chat.update({ channel: session.channel, ts, text: '❓ Claude asks a question', blocks })
    else ts = (await enqueue(session.channel, () => web.chat.postMessage({ channel: session.channel, text: '❓ Claude asks a question', blocks }))).ts
  } catch (e) { log('qform relay error', e?.data?.error || String(e)); return }
  qforms.set(session.id, { ts, hash: form.hash, options: form.options, at: Date.now(), planFor: form.planPath ? form.hash : prev?.planFor })
  log('qform relayed', session.id.slice(0, 8), JSON.stringify(form.question.slice(0, 60)))
}
async function answerQuestionForm(session, n, label) {
  await execFile('tmux', ['send-keys', '-t', session.tmux, String(n)]) // digit selects + advances
  const q = qforms.get(session.id)
  if (q) {
    q.hash = 'answered:' + Date.now() // next screen (if any) updates the same message
    try { await web.chat.update({ channel: session.channel, ts: q.ts, text: `✅ ${label}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `❓ → ✅ *${escapeText(label)}*` } }] }) } catch {}
  }
  log('qform answered', session.id.slice(0, 8), n, JSON.stringify(label.slice(0, 50)))
}
async function clearQuestionForm(session) {
  const q = providerOf(session) === 'claude' ? qforms.get(session.id) : null
  if (!q) return
  qforms.delete(session.id)
  try { await web.chat.update({ channel: session.channel, ts: q.ts, text: '✅ Question answered', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '❓ → ✅ _answered — the turn continues_' } }] }) } catch {}
}

function startPoller(session) {
  if (pollers.has(session.id)) return
  const p = { timer: null, last: '', stopped: false, sawSpinner: false, idle: 0 }
  p.timer = setInterval(async () => {
    if (p.stopped || !session.tmux || !(session.pid && pidAlive(session.pid))) return
    const pane = await tmuxCapture(session.tmux)
    const line = extractSpinner(pane)
    if (p.stopped) return // Stop fired during the capture — don't re-post
    if (line) {
      p.sawSpinner = true; p.idle = 0
      if (qforms.has(session.id)) await clearQuestionForm(session) // answered (Slack or terminal) — turn resumed
      if (line !== p.last) { p.last = line; await setStatus(session, line) }
    } else {
      const form = extractQuestionForm(pane)
      if (form) { p.idle = 0; await relayQuestionForm(session, form); return } // waiting on the user, not finished
      if (p.sawSpinner && !hasPendingPerm(session) && ++p.idle >= 4) {
        // The spinner vanished for ~12s after a turn was running: the turn ended.
        // Normally the Stop hook finalizes; if it never arrives (a missed hook, or a
        // long/compacted turn), do it here so the response is never silently lost.
        p.stopped = true
        log('poller finalize (Stop hook missing)', session.id.slice(0, 8))
        await finalizeTurn(session)
      }
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
  await clearQuestionForm(session)
  if (session.transcript) await waitTranscriptSettle(session.transcript)
  const text = readNewAssistantText(session)
  if (text) await postMd(session.channel, text)
  saveState(state)
  // Plan-approval (and similar) dialogs render AFTER the Stop hook, when no
  // poller is watching — check once, shortly after, and hand off to a poller.
  setTimeout(async () => {
    try {
      if (!(session.pid && pidAlive(session.pid) && session.tmux && (await tmuxAlive(session.tmux)))) return
      const form = extractQuestionForm(await tmuxCapture(session.tmux))
      if (form) { await relayQuestionForm(session, form); startPoller(session) }
    } catch (e) { log('post-stop form check failed', String(e?.message || e)) }
  }, 5000)
}

// Codex exposes the stable final assistant text directly on Stop. Its JSONL
// transcript is explicitly not a stable hook interface, so never parse it.
async function finalizeCodexTurn(session, body) {
  await clearStatus(session)
  const turnId = body.turn_id || null
  if (turnId && session.lastMirroredTurn === turnId) return
  const text = String(body.last_assistant_message || '').trim()
  if (text && session.channel) await postMd(session.channel, text)
  if (turnId) session.lastMirroredTurn = turnId
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
    if (providerOf(s) !== 'claude') continue // pane parsing below is Claude-TUI-specific
    if (!(s.pid && pidAlive(s.pid) && s.tmux && (await tmuxAlive(s.tmux)))) continue
    const pane = await tmuxCapture(s.tmux)
    const spinning = !!extractSpinner(pane)
    const waitingForm = !spinning && !!extractQuestionForm(pane)
    const ts = await findStatusMessage(s.channel)
    if (waitingForm) {
      startPoller(s) // poller relays the form and manages the answer
      log('re-adopted session waiting at a question form', s.id.slice(0, 8))
    } else if (spinning) {
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
  if (providerOf(session) !== 'claude') return ''
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
// A session's tmux claim is only trusted if the claiming claude process really
// lives inside that tmux (its pid descends from one of the session's panes).
// Inherited CCS_TMUX env leaks made new sessions claim ANOTHER session's tmux,
// so their Slack messages were pasted into the wrong terminal. Cached per
// pid+name — one validation per session lifetime in practice.
const tmuxClaimCache = new Map()
async function validTmuxClaim(pid, tname) {
  if (!tname) return false
  const key = pid + ':' + tname
  if (tmuxClaimCache.has(key)) return tmuxClaimCache.get(key)
  let ok = false
  try {
    const panePids = (await execFile('tmux', ['list-panes', '-t', tname, '-F', '#{pane_pid}']))
      .stdout.split('\n').filter(Boolean).map(Number)
    let p = Number(pid)
    for (let i = 0; i < 12 && p > 1 && !ok; i++) {
      if (panePids.includes(p)) ok = true
      else p = Number((await execFile('ps', ['-o', 'ppid=', '-p', String(p)])).stdout.trim()) || 0
    }
  } catch { ok = false } // tmux session doesn't exist → claim invalid
  tmuxClaimCache.set(key, ok)
  if (!ok) log('rejected tmux claim', tname, 'by pid', pid)
  return ok
}

async function onHook(body, ppid, tmux, flags, account, requestedProvider = 'claude') {
  const provider = normalizeProvider(requestedProvider)
  if (!provider) return
  const ev = body.hook_event_name
  const pid = await resolveAgentPid(ppid, provider)
  if (!pid) return
  if (tmux && !(await validTmuxClaim(pid, tmux))) tmux = null
  const sid = body.session_id
  if (!sid) return

  let session = state.sessions[sid] || sessionByPid(pid)
  if (session && isSupersededHook(ev, session.pid, pid)) {
    log('ignored hook from superseded pid', ev, pid, 'current', session.pid, String(sid).slice(0, 8))
    return
  }
  if (session && providerOf(session) !== provider) {
    log('rejected cross-provider session collision', String(sid).slice(0, 8), provider)
    return
  }
  if (!session) {
    // Claude Code 2.1.220+ spawns internal background workers — a transient
    // per-user daemon, warm "spare" sessions, and background agents — which
    // inherit CCS_BRIDGE and the global hooks from their parent session. They
    // are not user terminals: registering them creates ghost channels. Gate NEW
    // registrations on the resolved process's command line.
    if (provider === 'claude') {
      let cmdline = ''
      try { cmdline = (await execFile('ps', ['-o', 'command=', '-p', String(pid)])).stdout } catch {}
      if (/--agent |bg-pty-host|bg-spare|daemon run|--session-id/.test(cmdline)) {
        log('ignoring internal claude worker', sid.slice(0, 8), 'pid', pid)
        return
      }
    }
    // Adopt at the transcript's current end. A session the daemon has never seen
    // may carry a long pre-bridge history (e.g. resuming an old session into a
    // new channel); an offset of 0 would replay ALL of it into Slack on the
    // first turn. Anchoring to EOF mirrors only from adoption onward. Brand-new
    // sessions have an empty/absent transcript, so this stays 0 for them.
    let tail = 0
    if (provider === 'claude') { try { tail = fs.statSync(body.transcript_path).size } catch {} }
    session = { id: sid, pid, cwd: body.cwd, tmux, transcript: body.transcript_path, offset: tail, channel: null, statusTs: null }
    if (provider === 'codex') session.provider = 'codex'
    state.sessions[sid] = session
  }
  // Keep identity fresh (handles /clear: same pid, new sid). This path REBRANDS an
  // existing session record, so it must not be reachable by a stray hook: a payload
  // whose pid merely resolves to some live claude could otherwise steal that
  // session's channel and orphan it. Require the payload's own transcript to belong
  // to the new id, and require the same terminal.
  if (session.id !== sid) {
    const transcriptMatches = provider === 'codex' || !body.transcript_path || path.basename(body.transcript_path, '.jsonl') === sid
    const sameTerminal = !tmux || !session.tmux || tmux === session.tmux
    if (!transcriptMatches || !sameTerminal) {
      log('rejected identity takeover of', session.id.slice(0, 8), 'by', String(sid).slice(0, 8),
        `(transcript=${transcriptMatches}, sameTerminal=${sameTerminal})`)
      return
    }
    delete state.sessions[session.id]
    if (session.channel) state.channels[session.channel] = sid
    session.id = sid
    session.offset = 0
    state.sessions[sid] = session
  }
  session.pid = pid
  session.tmux = tmux || session.tmux
  if (session.channel && session.tmux) state.channelTmux[session.channel] = session.tmux
  // Heal stored claims too (a poisoned name may have been recorded before the guard).
  if (session.tmux && !tmux && !(await validTmuxClaim(pid, session.tmux))) session.tmux = null
  session.cwd = body.cwd || session.cwd
  session.transcript = body.transcript_path || session.transcript
  if (provider === 'codex' && body.model && (ev === 'SessionStart' || !restarting.has(sid))) session.model = body.model
  // During a bridge-initiated restart, the old process may emit trailing hooks
  // after the desired settings were persisted. Never let one roll them back;
  // the replacement SessionStart is allowed to confirm its actual launch values.
  const acceptSettings = acceptHookSettings(ev, restarting.has(sid))
  if (acceptSettings && flags != null && flags !== '') {
    session.launchFlags = provider === 'codex' ? codexFlagsWithoutInitialPrompt(flags, sid) : flags
  }
  if (provider === 'codex' && ev === 'SessionStart') {
    const effort = resolveCodexEffort({ launchFlags: session.launchFlags, cwd: session.cwd })
    if (effort) session.effort = effort
  }
  const acct = provider === 'claude' ? safeAccount(account) : null
  if (acceptSettings && acct && session.account !== acct) session.account = acct // which subscription pays for this session
  saveState(state)

  if (ev === 'SessionStart') {
    restarting.delete(sid) // a resumed /cc-update session is up; re-enable the "ended" notice
    resurrectInFlight.delete(sid) // the wake completed; future resurrects are legitimate
    if (session.tmux) clearKillOnClose(session.tmux) // window close must NOT kill the session (Ghostty single-instance cascade)
    if (session.tmux) tmuxTitle(session.tmux, session.cwd || 'ccs') // initial title; updateTopic enriches it (folder · branch · model · effort)
    const ch = await ensureChannel(session)
    await updateTopic(session) // existing channels also need fresh SessionStart metadata
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
    if (provider === 'claude') startPoller(session) // Claude TUI-specific spinner/form relay
    else await setStatus(session, '⚙️ Codex is working…')
    return
  }
  if (ev === 'PreToolUse') {
    // Stream out any prose Claude wrote before this tool call, so the channel
    // shows the turn unfolding. Clearing the status lets the poller repost the
    // live spinner below the new prose on its next tick.
    if (provider !== 'claude') return
    const text = readNewAssistantText(session)
    if (text) { await clearStatus(session); await postMd(session.channel, text) }
    return
  }
  if (ev === 'Stop') {
    log('stop hook', session.id.slice(0, 8))
    if (provider === 'codex') await finalizeCodexTurn(session, body)
    else await finalizeTurn(session)
    return
  }
  if (ev === 'SessionEnd') {
    stopPoller(session)
    await clearStatus(session)
    if (session.channel && !restarting.has(sid)) await post(session.channel, '💤 *Session ended* — write here to resume it')
    clearPermissionsForPid(session.pid, 'session ended')
    session.pid = null
    saveState(state)
    return
  }
}

// ---- permission relay -------------------------------------------------------
const codexPermissionWaiters = new Map() // short request id → held hook response
function clearPermissionsForPid(pid, reason = 'session ended') {
  if (!pid) return 0
  let cleared = 0
  for (const [rid, request] of Object.entries(state.perms)) {
    if (Number(request.pid) !== Number(pid)) continue
    delete state.perms[rid]
    const waiter = codexPermissionWaiters.get(rid)
    if (waiter) {
      codexPermissionWaiters.delete(rid)
      clearTimeout(waiter.timer)
      if (!waiter.res.writableEnded) waiter.res.end('{}')
    }
    web.chat.update({
      channel: request.channel, ts: request.ts,
      text: `⌛ Permission request closed (${reason})`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⌛ *Permission request closed* — ${reason}` } }],
    }).catch(() => {})
    cleared++
  }
  if (cleared) saveState(state)
  return cleared
}
function permissionId() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz'
  let id = ''
  do {
    id = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  } while (state.perms[id])
  return id
}
async function postPermissionPrompt(channel, p) {
  const preview = String(p.input_preview || '').slice(0, 1200)
  const agent = p.provider === 'codex' ? 'Codex' : 'Claude'
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `🔐 *${agent} wants to use \`${escapeText(p.tool_name || 'a tool')}\`*\n${escapeText(String(p.description || '').slice(0, 600))}` } },
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
  const waiter = codexPermissionWaiters.get(rid)
  if (waiter) {
    codexPermissionWaiters.delete(rid)
    clearTimeout(waiter.timer)
    if (!waiter.res.writableEnded) waiter.res.end(JSON.stringify(codexPermissionDecision(behavior)))
  } else {
    const s = streams.get(req.pid)
    if (s) s.res.write(`data: ${JSON.stringify({ type: 'permission_verdict', request_id: rid, behavior })}\n\n`)
  }
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
function resumeArgs(session, initialPrompt = null) {
  const withMeta = session.effort ? session : { ...session, effort: sessionMeta.get(session.id)?.effort }
  return resumeArgsFor(withMeta, {
    defaultClaudeFlags: process.env.CCS_RESUME_FLAGS || '--dangerously-skip-permissions',
    defaultCodexFlags: process.env.CCS_CODEX_RESUME_FLAGS || CODEX_DANGEROUS_FLAG,
    initialPrompt,
  })
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
  if (providerOf(session) === 'codex') return session.cwd
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
  let initialPrompt = null
  try {
    const anchored = resumeCwd(session)
    if (anchored !== session.cwd) { log('resume cwd re-anchored', session.id.slice(0, 8), session.cwd, '→', anchored); session.cwd = anchored; saveState(state) }
    const provider = providerOf(session)
    // Claude Code scopes --resume to the cwd's project, so the folder must exist at
    // its original path. If it's gone (e.g. a deleted worktree), recreate it empty —
    // the transcript in ~/.claude/projects survives, so the conversation resumes.
    if (!fs.existsSync(session.cwd)) {
      try {
        fs.mkdirSync(session.cwd, { recursive: true })
        await post(session.channel, `⚠️ Folder \`${session.cwd}\` was gone — recreated it empty and resuming there. The conversation is intact; files from the original folder are not.`)
      } catch (e) {
        const manual = provider === 'codex' ? `codex resume ${session.id}` : `claude --resume ${session.id}`
        return post(session.channel, `❌ Can't resume — folder \`${session.cwd}\` is gone and couldn't be recreated (${e?.code || e}). The transcript is preserved; resume manually with \`${manual}\` from a valid directory.`)
      }
    }
    await post(session.channel, '⏳ *Waking this session up on the Mac…*')
    // Codex does not necessarily emit SessionStart while a resumed TUI is idle.
    // Waiting for that hook before pasting the wake message therefore deadlocks:
    // local typing starts the first turn, then the hook finally flushes Slack's
    // queue. Codex resume accepts an optional PROMPT, so consume exactly the
    // first queued message into argv; it starts the turn and unlocks SessionStart.
    // Later messages stay queued and are flushed by the existing hook path.
    if (provider === 'codex') {
      const queued = pendingBySid.get(session.id) || []
      initialPrompt = queued.shift() ?? text ?? null
      pendingBySid.set(session.id, queued)
      if (initialPrompt) {
        rememberInjected(session.id, initialPrompt) // suppress the hook echo; Slack already shows it
        log('codex resume bootstrapped queued prompt', session.id.slice(0, 8))
      }
    }
    const args = resumeArgs(session, initialPrompt)
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
        autoConsent: provider === 'claude',
        account: provider === 'claude' ? session.account : null, // Claude-only subscription binding
        provider,
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
    if (!up) {
      resurrectInFlight.delete(session.id)
      if (initialPrompt) {
        const queued = pendingBySid.get(session.id) || []
        pendingBySid.set(session.id, [initialPrompt, ...queued])
      }
    }
  }
}
const pendingBySid = new Map()

// /cc-update: stop this session's agent, update the CLI if a newer build exists,
// then resume the same conversation with identical launch flags.
async function updateAndRestart(session) {
  const provider = providerOf(session)
  const label = providerLabel(provider)
  const before = await agentVersion(provider)
  await post(session.channel, `🔄 *Restarting ${path.basename(session.cwd)}* — stopping ${label}, checking for updates, then resuming with the same flags.`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session); await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null; saveState(state)
  await sleep(1500) // let the old process fully exit before the binary is swapped
  let note = ''
  try {
    const bin = provider === 'codex' ? codexBin() : claudeBin()
    const { stdout, stderr } = await execFile(bin, ['update'], { timeout: 180000 })
    note = (stdout + '\n' + stderr).split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
  } catch (e) { note = `error: ${e?.stderr?.trim() || e?.message || e}` }
  if (provider === 'codex') codexModelCache = null
  else modelCache = { key: null, list: [] }
  const after = await agentVersion(provider)
  const ver = before !== after ? `updated \`${before}\` → \`${after}\``
    : /error|fail/i.test(note) ? `⚠️ update check failed — staying on \`${after}\` (${note.slice(0, 120)})`
    : `already on the latest (\`${after}\`)`
  await post(session.channel, `📦 ${label} ${ver}. Resuming the conversation…`)
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

  // The ./ commands were retired in favour of native namespaced slash commands; nudge.
  const dot = /^\.\/(\w+)/.exec(trimmed)
  if (dot && RETIRED_CMDS.has(dot[1])) {
    const provider = providerOf(sessionByChannel(channel))
    const prefix = provider === 'codex' ? 'codex-' : 'cc-'
    return post(channel, `\`./\` commands are retired — use \`${slackCommand(provider, dot[1])}\` instead (type \`/${prefix}\` for the list).`)
  }

  const session = sessionByChannel(channel)
  if (!session) {
    if (channel === state.control) return post(channel, 'This is the control channel. Use `/cc-new` or `/codex-new` to start a session; `/cc-status` and `/codex-status` list each provider.')
    log('inbound (unmapped channel, ignored)', channel)
    return
  }
  // An open question form eats pasted text, so route replies through it instead:
  // a bare number picks that option; anything else goes via "Type something" /
  // "Chat about this" when the form offers one.
  const q = qforms.get(session.id)
  if (q && Date.now() - q.at < 30 * 60000 && session.tmux && (await tmuxAlive(session.tmux))) {
    if (/^\d{1,2}$/.test(trimmed)) {
      const o = q.options.find(x => String(x.n) === trimmed)
      if (o) return answerQuestionForm(session, o.n, o.label)
    }
    const free = q.options.find(o => /type something/i.test(o.label)) || q.options.find(o => /chat about this/i.test(o.label)) || q.options.find(o => /tell claude what to change/i.test(o.label))
    if (free) {
      await answerQuestionForm(session, free.n, `${free.label} → “${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}”`)
      await sleep(700)
      return tmuxPaste(session.tmux, trimmed)
    }
    return post(channel, '❓ A question form is open — tap a button above or reply with just its number.')
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
  if (providerOf(session) === 'codex') return session.model || null
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

async function spawnNew(channel, dir, extraFlags, provider = 'claude') {
  const cwd = path.resolve(dir.replace(/^~/, process.env.HOME))
  if (!isPathWithin(process.env.HOME, cwd) || !fs.existsSync(cwd)) return post(channel, `❌ Directory not allowed or missing: \`${cwd}\``)
  provider = normalizeProvider(provider)
  if (!provider) return post(channel, '❌ Unknown session provider.')
  // `--account <name>` picks the subscription; it is bridge config, not a claude flag.
  let account = null
  const ai = extraFlags.indexOf('--account')
  if (ai >= 0) {
    account = safeAccount(extraFlags[ai + 1])
    if (!account) return post(channel, `❌ Invalid account name after \`--account\`.`)
    if (!listAccounts().includes(account)) return post(channel, `❌ Unknown account \`${account}\`.`)
    extraFlags = extraFlags.filter((_, i) => i !== ai && i !== ai + 1)
  }
  if (provider === 'codex' && account) return post(channel, '❌ `--account` is only available for Claude Code sessions.')
  if (!extraFlags.length) extraFlags = defaultNewFlags(provider) // provider-specific operator default
  const flags = []
  for (const f of extraFlags) {
    const norm = normalizeLaunchFlag(provider, f)
    if (norm) flags.push(norm)
    else return post(channel, `❌ Flag not allowed: \`${f}\``)
  }
  const tmuxName = `ccs-new-${Date.now().toString(36)}`
  await post(channel, `🚀 Spawning \`${providerCommand(provider)} ${flags.join(' ')}\` in \`${cwd}\`${account ? ` under \`${account}\`` : ''}…`)
  await reapGhosttyZombies() // windowless-instance pileup breaks new windows
  await ghosttySpawn({ cwd, args: flags, title: `ccs ${path.basename(cwd)}`, tmuxName, autoConsent: provider === 'claude', account, provider })
  let up = false
  for (let i = 0; i < 24 && !up; i++) { await sleep(500); up = await tmuxAlive(tmuxName) }
  if (!up) await post(channel, `⚠️ *The terminal window never initialized* (Ghostty looks wedged). Quit Ghostty on the Mac and try \`${slackCommand(provider, 'new')}\` again.`)
}

const codeDir = () => process.env.CCS_CODE_DIR || path.join(process.env.HOME, 'Code')
async function postFolderPicker(channel, provider = 'claude') {
  const base = codeDir()
  let dirs = []
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort() } catch {}
  if (!dirs.length) return post(channel, `No projects in \`${base}\`. Set CCS_CODE_DIR, or use \`${slackCommand(provider, 'new')} <folder>\`.`)
  const options = dirs.slice(0, 100).map(d => ({ text: { type: 'plain_text', text: d.slice(0, 75) }, value: d.slice(0, 75) }))
  await web.chat.postMessage({
    channel, text: 'Pick a project to start a session in',
    blocks: [{
      type: 'section', text: { type: 'mrkdwn', text: `*Start a ${providerLabel(provider)} session* — pick a project in \`${base}\`:` },
      accessory: { type: 'static_select', action_id: provider === 'codex' ? 'ccnew_folder_codex' : 'ccnew_folder', placeholder: { type: 'plain_text', text: 'Choose a project…' }, options },
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

// ---- per-session subscriptions ----------------------------------------------
// A session can run under a named Claude account (see bin/ccs-account), so each
// person's work bills to their own subscription. The daemon only ever handles
// NAMES — tokens live in ~/.config/ccs/accounts (0600) and are resolved inside
// `ccs` at launch, never passed through argv, state, or Slack.
function listAccounts() {
  try {
    return fs.readFileSync(path.join(CONFIG_DIR, 'accounts'), 'utf8')
      .split('\n').map(l => l.split('=')[0].trim()).filter(n => safeAccount(n))
  } catch { return [] }
}
async function switchAccount(session, name) {
  const label = name ? `\`${name}\`` : "this machine's own login"
  await post(session.channel, `🔐 *Switching subscription* → ${label}. Restarting and resuming this conversation…`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session); await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null
  session.account = name || null
  saveState(state)
  await sleep(1500)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000)
}

// Launch flags a session was started with, minus the resume plumbing (which the
// daemon re-adds itself) — i.e. what the user actually chose.
function displayFlags(session) {
  return displayFlagsFor(session)
}

// Change a live session's launch flags. Claude Code reads them at startup, so
// this restarts the session and resumes the same conversation — the same dance
// as /cc-account and /cc-update.
async function setFlags(session, flags) {
  await post(session.channel, `🔧 *Setting launch flags* → \`${flags.join(' ') || '(none)'}\`. Restarting and resuming this conversation…`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session); await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null
  session.launchFlags = flags.join(' ')
  saveState(state)
  await sleep(1500)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000)
}

async function setCodexSetting(session, name, value) {
  session[name] = value
  sessionMeta.set(session.id, { ...(sessionMeta.get(session.id) || {}), [name]: value })
  const alive = session.pid && pidAlive(session.pid)
  if (!alive) {
    saveState(state)
    return post(session.channel, `✅ ${name} → \`${value}\` — it will apply on the next resume.`)
  }
  await post(session.channel, `🔧 *Setting ${name}* → \`${value}\`. Restarting Codex and resuming this conversation…`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null
  saveState(state)
  await sleep(1500)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000)
}

// Flags a provider-specific new session gets when none are given. Configurable because the
// right default is a matter of taste and risk appetite (CCS_NEW_FLAGS).
const defaultNewFlags = (provider = 'claude') => defaultNewFlagsFor(provider)

const SESSION_SCOPED_COMMANDS = new Set(['status', 'kill', 'model', 'effort', 'stop', 'update', 'restart', 'flags'])
const CLAUDE_ONLY_COMMANDS = new Set(['account', 'usage'])
const BRIDGE_COMMANDS = new Set(['claim', 'health', 'cleanup'])

function commandHelp(provider) {
  if (provider === 'codex') {
    return '*Codex commands* — type `/codex-` to autocomplete\n' +
      '`/codex-new [folder] [--yolo] [--search]` — start a Codex session\n' +
      '`/codex-model [m]` · `/codex-effort [e]` — show or set Codex model/reasoning effort\n' +
      '`/codex-update` — update Codex CLI and restart/resume this session\n' +
      '`/codex-flags [--yolo --search …]` — show or change Codex launch flags (restarts/resumes)\n' +
      '`/codex-stop` — interrupt the running turn\n' +
      '`/codex-status` — session info here, or list Codex sessions from control\n' +
      '`/codex-kill [here|<id>]` — end a Codex session (channel stays, resumable)\n' +
      '*Bridge-wide commands remain under `/cc-`:* `/cc-health` · `/cc-cleanup` · `/cc-claim`\n' +
      '_Usage reporting and subscription switching are currently Claude-only._'
  }
  return '*Claude Code commands* — type `/cc-` to autocomplete\n' +
    '`/cc-new [folder] [--dsp] [--chrome]` — start a Claude Code session\n' +
    '`/cc-model [m]` · `/cc-effort [e]` — show or set Claude model/reasoning effort\n' +
    '`/cc-update` — update Claude Code and restart/resume this session\n' +
    '`/cc-account [name]` — choose the Claude subscription for this session\n' +
    '`/cc-flags [--dsp --chrome …]` — show or change Claude launch flags (restarts/resumes)\n' +
    '`/cc-stop` — interrupt the running turn\n' +
    '`/cc-status` — session info here, or list Claude sessions from control\n' +
    '`/cc-usage [days [n] | models | limits]` — Claude usage and plan limits\n' +
    '`/cc-kill [here|<id>]` — end a Claude session (channel stays, resumable)\n' +
    '`/cc-health` — bridge status · `/cc-cleanup` — archive dormant channels'
}

// Provider namespaces are explicit at ingress: /cc-* is Claude and
// /codex-* is Codex. The implementation remains shared below.
async function dispatch(name, rest, channel, commandProvider = 'claude') {
  const cmd = commandName => slackCommand(commandProvider, commandName)
  if (name === 'help') {
    return post(channel, commandHelp(commandProvider))
  }
  if (commandProvider === 'codex' && (CLAUDE_ONLY_COMMANDS.has(name) || BRIDGE_COMMANDS.has(name))) {
    return post(channel, `\`${cmd(name)}\` is not registered. ${BRIDGE_COMMANDS.has(name) ? `Use the bridge-wide \`/cc-${name}\`.` : 'This command is Claude-only.'}`)
  }
  const channelSession = channel !== state.control ? sessionByChannel(channel) : null
  if (channelSession && SESSION_SCOPED_COMMANDS.has(name) && providerOf(channelSession) !== commandProvider) {
    const actualProvider = providerOf(channelSession)
    return post(channel, `This is a ${providerLabel(actualProvider)} session. Use \`${slackCommand(actualProvider, name === 'restart' ? 'update' : name)}\` here.`)
  }
  if (name === 'status') {
    const session = channelSession
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
        `| Provider | ${providerLabel(providerOf(session))} |\n` +
        `| Folder | ${session.cwd} |\n` +
        `| Branch | ${branch || '—'}${worktree ? ` · wt:${worktree}` : ''} |\n` +
        `| Model | ${meta.model || readModel(session) || '—'} |\n` +
        `| Effort | ${meta.effort || session.effort || '—'} |\n` +
        `| Changes | ${changes} |` +
        (gs ? '\n```\n' + gs.slice(0, 1200) + '\n```' : ''))
      await web.chat.postMessage({ channel, text: 'Collaborators', blocks: await collabBlocks(channel) })
      return
    }
    const rows = Object.values(state.sessions).filter(s => providerOf(s) === commandProvider).map(s => {
      const alive = s.pid && pidAlive(s.pid)
      return `| ${path.basename(s.cwd)} | ${providerLabel(providerOf(s))} | ${s.id.slice(0, 8)} | ${alive ? '🟢 active' : '💤 dormant'} |`
    })
    return postMd(channel, `| Session | Provider | ID | State |\n|---|---|---|---|\n${rows.join('\n') || '| _none_ | | | |'}`)
  }
  if (name === 'health') {
    const sess = Object.values(state.sessions)
    const active = sess.filter(s => s.pid && pidAlive(s.pid)).length
    const codex = sess.filter(s => providerOf(s) === 'codex').length
    const claude = sess.length - codex
    const up = Math.round((Date.now() - BOOT_TS) / 1000)
    const hms = up < 3600 ? `${Math.round(up / 60)}m` : `${(up / 3600).toFixed(1)}h`
    return postMd(channel,
      `| Bridge health | |\n|---|---|\n` +
      `| Uptime | ${hms} |\n` +
      `| Sessions | ${active} active, ${sess.length - active} dormant |\n` +
      `| Providers | ${claude} Claude, ${codex} Codex |\n` +
      `| Channel servers attached | ${streams.size} |\n` +
      `| Open permission prompts | ${Object.keys(state.perms).length} |`)
  }
  if (name === 'kill') {
    const target = rest[0] && rest[0] !== 'here'
      ? Object.values(state.sessions).find(s => providerOf(s) === commandProvider && s.id.startsWith(rest[0]))
      : sessionByChannel(channel)
    if (!target) return post(channel, `No matching ${providerLabel(commandProvider)} session — use \`${cmd('kill')}\` in a session channel, or \`${cmd('kill')} <id-prefix>\`.`)
    if (target.tmux) await tmuxKill(target.tmux)
    if (target.pid && pidAlive(target.pid)) { try { process.kill(target.pid) } catch {} }
    await clearStatus(target)
    clearPermissionsForPid(target.pid, 'session ended')
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
    if (!session) return post(channel, `Use \`${cmd(name)}\` in a ${providerLabel(commandProvider)} session channel.`)
    const provider = providerOf(session)
    const meta = sessionMeta.get(session.id) || {}
    if (!rest.length) {
      if (name === 'model') {
        const cur = meta.model || readModel(session) || 'unknown'
        if (provider === 'codex') {
          const models = await getCodexModels()
          if (models.length) {
            const rows = models.map(m => `| \`${m.id}\` | ${m.name} | ${m.efforts.join(' · ') || '—'} |`).join('\n')
            return postMd(channel, `*Model* — current: \`${cur}\`\nSet with \`${cmd('model')} <id>\`:\n| Model id | Name | Efforts |\n|---|---|---|\n${rows}`)
          }
          return post(channel, `*model*: \`${cur}\`\nSet with \`${cmd('model')} <id>\`.`)
        }
        const models = await getModels()
        if (models.length) {
          const rows = models.map(m => `| \`${m.alias}\` | ${m.name} | \`${m.id}\` |`).join('\n')
          const hasLong = models.some(m => /-1m$/.test(m.alias))
          return postMd(channel, `*Model* — current: \`${cur}\`\nSet with \`${cmd('model')} <alias>\` (or a full id):\n| Alias | Model | Full id |\n|---|---|---|\n${rows}` +
            (hasLong ? '\n_A family alias picks the *1M-context* variant when one exists — pass the full id for the standard window._' : ''))
        }
        return post(channel, `*model*: \`${cur}\`\nSet with \`${cmd('model')} <value>\`  (sonnet · opus · haiku · fable)`)
      }
      const efforts = provider === 'codex' ? CODEX_EFFORTS.join(' · ') : 'low · medium · high · max'
      return post(channel, `*effort*: \`${meta.effort || session.effort || 'unknown'}\`\nSet with \`${cmd('effort')} <value>\`  (${efforts})`)
    }
    if (provider === 'codex') {
      const val = rest.join(' ').toLowerCase()
      if (name === 'effort' && !CODEX_EFFORTS.includes(val)) {
        return post(channel, `❌ Unsupported Codex effort \`${val}\`. Use: ${CODEX_EFFORTS.join(' · ')}`)
      }
      return setCodexSetting(session, name, val)
    }
    if (!(session.pid && pidAlive(session.pid))) return post(channel, 'Session not active — send a message first to wake it.')
    let val = rest.join(' ')
    if (name === 'model') {
      // A bare family alias selects the LONG-CONTEXT variant when this build has
      // one (`opus` → claude-opus-5[1m]): the bigger window is the better default
      // for bridged sessions, which run long. Claude Code's own alias resolves to
      // the standard variant, so we translate to the full id ourselves. Passing a
      // full id (e.g. `claude-opus-5`) still selects exactly that.
      const models = await getModels()
      const want = val.toLowerCase()
      const pick = models.find(m => m.alias.toLowerCase() === `${want}-1m`)
                || models.find(m => m.alias.toLowerCase() === want)
      if (pick) val = pick.id
    }
    await sendMenuCommand(session.tmux, `/${name} ${val}`)
    sessionMeta.set(session.id, { ...meta, [name]: val })
    if (name === 'effort') { session.effort = val; saveState(state) } // persist so resume restores it
    return post(channel, `✅ ${name} → \`${val}\``)
  }
  if (name === 'stop') {
    const session = sessionByChannel(channel)
    if (!session?.tmux || !(session.pid && pidAlive(session.pid))) return post(channel, 'No active session here to interrupt.')
    await tmuxInterrupt(session.tmux, providerOf(session))
    return post(channel, '⎋ *Interrupted* the running turn.')
  }
  if (name === 'usage') {
    const session = channel !== state.control ? sessionByChannel(channel) : null
    if (session && providerOf(session) === 'codex') {
      return post(channel, 'Codex usage reporting is not exposed through the bridge yet — run `/usage` in the Codex terminal.')
    }
    const sub = (rest[0] || '').toLowerCase()
    if (sub === 'limits') return usageLimits(channel) // instant — no transcript scan
    await post(channel, '⏳ Crunching transcripts…')
    try {
      if (sub === 'days' || sub === 'daily') return await usageDays(channel, rest[1])
      if (sub === 'models') return await usageModels(channel)
      return await usageReport(channel)
    } catch (e) { log('usage error', String(e)); return post(channel, `⚠️ ccusage failed: ${String(e?.message || e).slice(0, 200)}`) }
  }
  if (name === 'account') {
    const session = sessionByChannel(channel)
    const available = listAccounts()
    const known = available.length ? available.map(a => `\`${a}\``).join(' · ') : '_none yet — add one on the Mac with_ `ccs-account add <name>`'
    if (!session) return post(channel, `*Subscriptions available:* ${known}\nRun \`/cc-account <name>\` in a session channel to bind that session to an account.`)
    if (providerOf(session) === 'codex') return post(channel, '`/cc-account` is Claude-only; Codex uses the machine’s current Codex login.')
    const cur = session.account ? `\`${session.account}\`` : "this machine's own Claude login (default)"
    if (!rest.length) {
      return post(channel, `*Subscription for this session:* ${cur}\n*Available:* ${known}\nSwitch with \`/cc-account <name>\` (or \`/cc-account default\`). The session restarts and resumes — the conversation is kept.`)
    }
    const want = rest[0].toLowerCase()
    if (want === 'default' || want === 'none') return switchAccount(session, null)
    const picked = safeAccount(rest[0])
    if (!picked || !available.includes(picked)) return post(channel, `❌ Unknown account \`${rest[0]}\`. *Available:* ${known}`)
    if (picked === session.account) return post(channel, `Already running under \`${picked}\`.`)
    return switchAccount(session, picked)
  }
  if (name === 'update' || name === 'restart') {
    const session = sessionByChannel(channel)
    if (!session) return post(channel, `Use \`${cmd('update')}\` in a ${providerLabel(commandProvider)} session channel — it updates that CLI and restarts the session with the same flags.`)
    return updateAndRestart(session)
  }
  if (name === 'flags') {
    const session = sessionByChannel(channel)
    if (!session) return post(channel, `Use \`${cmd('flags')}\` in a ${providerLabel(commandProvider)} session channel.`)
    const provider = providerOf(session)
    const alias = provider === 'claude' ? ' (`--dsp` works too)' : ' (`--yolo` works too)'
    const allowed = allowedFlags(provider).map(f => `\`${f}\``).join(' · ') + alias
    if (!rest.length) {
      const cur = displayFlags(session)
      return post(channel, `*Launch flags:* ${cur.length ? '\`' + cur.join(' ') + '\`' : '_none_'}\n` +
        `Set with \`${cmd('flags')} <flags…>\` — the session restarts and resumes this conversation.\n*Allowed:* ${allowed}`)
    }
    const flags = []
    for (const f of rest) {
      const norm = normalizeLaunchFlag(provider, f)
      if (!norm) return post(channel, `❌ Flag not allowed: \`${f}\`\n*Allowed:* ${allowed}`)
      if (!flags.includes(norm)) flags.push(norm)
    }
    return setFlags(session, flags)
  }
  if (name === 'new') {
    const providerFlag = rest.find(arg => arg === '--codex' || arg === '--claude')
    if (providerFlag) {
      const requested = providerFlag === '--codex' ? 'codex' : 'claude'
      return post(channel, `❌ Provider flags are retired. Use \`${slackCommand(requested, 'new')}\`; the command namespace now selects the provider.`)
    }
    if (!rest.length) return postFolderPicker(channel, commandProvider)
    return spawnNew(channel, rest[0], rest.slice(1), commandProvider)
  }
  return post(channel, `Unknown command: \`${name}\`. Try \`${cmd('help')}\`.`)
}

// ---- HTTP (hooks in, SSE out) ----------------------------------------------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/hook' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      await onHook(JSON.parse(body), url.searchParams.get('ppid'), url.searchParams.get('tmux'),
        req.headers['x-ccs-flags'], req.headers['x-ccs-account'], req.headers['x-ccs-provider'] || 'claude')
    }
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
          if (j.model?.display_name && session.model !== j.model.display_name) { session.model = j.model.display_name; saveState(state) } // persist so topics survive restarts
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
  if (url.pathname === '/codex/permission' && req.method === 'POST') {
    let raw = ''
    for await (const c of req) raw += c
    res.setHeader('content-type', 'application/json')
    try {
      const p = JSON.parse(raw)
      const pid = await resolveAgentPid(url.searchParams.get('ppid'), 'codex')
      const session = state.sessions[p.session_id] || sessionByPid(pid)
      const tmux = url.searchParams.get('tmux')
      const validClaim = !tmux || await validTmuxClaim(pid, tmux)
      if (!session?.channel || providerOf(session) !== 'codex' ||
          (session.pid && session.pid !== pid) || (session.tmux && tmux && session.tmux !== tmux) || !validClaim) {
        log('codex perm-request: no Codex channel for pid', pid)
        return res.end('{}') // no hook decision → ordinary local approval prompt
      }
      const rid = permissionId()
      let preview = ''
      try { preview = JSON.stringify(p.tool_input ?? {}, null, 2) } catch { preview = String(p.tool_input || '') }
      const prompt = {
        request_id: rid,
        provider: 'codex',
        tool_name: p.tool_name || 'tool',
        description: p.tool_input?.description || 'Approval requested by Codex.',
        input_preview: preview,
      }
      const ts = await postPermissionPrompt(session.channel, prompt)
      state.perms[rid] = { pid, channel: session.channel, ts, tool: prompt.tool_name, provider: 'codex' }
      saveState(state)
      const timer = setTimeout(async () => {
        const waiter = codexPermissionWaiters.get(rid)
        if (!waiter) return
        codexPermissionWaiters.delete(rid)
        delete state.perms[rid]
        saveState(state)
        if (!res.writableEnded) res.end('{}')
        try {
          await web.chat.update({ channel: session.channel, ts, text: `⌛ Expired ${prompt.tool_name}`, blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `⌛ *Permission request expired* \`${escapeText(prompt.tool_name)}\`` } },
          ] })
        } catch {}
      }, 570000)
      codexPermissionWaiters.set(rid, { res, timer })
      res.on('close', () => {
        const waiter = codexPermissionWaiters.get(rid)
        if (!waiter || waiter.res !== res) return
        clearTimeout(waiter.timer)
        codexPermissionWaiters.delete(rid)
        delete state.perms[rid]
        saveState(state)
      })
      log('codex perm-request', rid, prompt.tool_name, '→', session.id.slice(0, 8))
    } catch (e) {
      log('codex perm-request error', String(e))
      if (!res.writableEnded) res.end('{}')
    }
    return
  }
  // Script-facing spawn API (localhost-only, same trust domain as /hook).
  // POST /spawn {cwd, flags[]} — launch a bridged session through the daemon so
  // external scripts (worktree tooling etc.) get the single-icon window path
  // and flag validation instead of rolling their own `open -na Ghostty`.
  if (url.pathname === '/spawn' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    try {
      const j = JSON.parse(body || '{}')
      const provider = normalizeProvider(j.provider || 'claude')
      if (!provider) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'unknown provider' })) }
      const cwd = path.resolve(String(j.cwd || '').replace(/^~/, process.env.HOME))
      if (!isPathWithin(process.env.HOME, cwd) || !fs.existsSync(cwd)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'cwd not allowed or missing' })) }
      const flags = []
      for (const f of j.flags || []) {
        const norm = normalizeLaunchFlag(provider, f) ||
          (provider === 'claude' && /^(fable|opus|sonnet|haiku|low|medium|high|max)$/.test(f) ? f : null)
        if (!norm) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: `flag not allowed: ${f}` })) }
        flags.push(norm)
      }
      const account = provider === 'claude' && j.account ? safeAccount(j.account) : null
      if (j.account && !account) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid account name' })) }
      const tmuxName = `ccs-new-${Date.now().toString(36)}`
      await ghosttySpawn({ cwd, args: flags, title: `ccs ${path.basename(cwd)}`, tmuxName, autoConsent: provider === 'claude', account, provider })
      log('spawned via /spawn', provider, cwd, JSON.stringify(flags), account ? `account=${account}` : '')
      res.end(JSON.stringify({ ok: true, tmux: tmuxName, provider }))
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) })) }
    return
  }
  // POST /window {tmux, title} — request a single-icon viewport for an existing
  // tmux session (adopt a stray window under the bridge instance).
  if (url.pathname === '/window' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    try {
      const j = JSON.parse(body || '{}')
      const t = String(j.tmux || '')
      if (!t || !(await tmuxAlive(t))) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'tmux session not found' })) }
      const ok = await requestBridgeWindow(t, String(j.title || `ccs ${t}`))
      res.end(JSON.stringify({ ok }))
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) })) }
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

// Native /cc-* and /codex-* slash commands (registered in the manifest and
// delivered over the socket). The namespace is the source of provider truth.
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
    const parsed = parseSlackCommand(body.command)
    if (!parsed) return respondEphemeral(body, 'Unknown bridge command.')
    const { name, provider } = parsed
    if (!USER) {
      if (provider !== 'claude' || name !== 'claim') return respondEphemeral(body, 'This bridge is unclaimed — run `/cc-claim` to become its owner.')
      USER = body.user_id
      persistOwner(USER)
      log('owner claimed', USER)
      await respondEphemeral(body, '👑 You own this bridge now. Check your private bridge control channel.')
      if (state.control) {
        try { await web.conversations.invite({ channel: state.control, users: USER }) } catch {}
        await post(state.control, `👑 <@${USER}> claimed this bridge. Type \`/cc-\` for Claude Code or \`/codex-\` for Codex; the matching \`-new\` and \`-help\` commands get you started.`).catch(() => {})
      }
      return
    }
    if (name === 'claim') {
      if (provider !== 'claude') return respondEphemeral(body, 'Ownership is bridge-wide — use `/cc-claim`.')
      return respondEphemeral(body, body.user_id === USER ? 'You already own this bridge.' : 'This bridge already has an owner.')
    }
    if (body.user_id !== USER) return
    const rest = String(body.text || '').trim().split(/\s+/).filter(Boolean)
    log('slash', body.command, JSON.stringify(body.text || ''))
    await dispatch(name, rest, body.channel_id, provider)
  } catch (e) { log('slash error', String(e)) }
})

// Interactive components: Approve/Deny buttons and provider folder pickers.
sm.on('interactive', async ({ body, ack }) => {
  try { await ack() } catch {}
  try {
    if (body?.type !== 'block_actions' || body.user?.id !== USER) return
    const action = body.actions?.[0]
    if (!action) return
    if (action.action_id === 'ccnew_folder' || action.action_id === 'ccnew_folder_codex') {
      const folder = action.selected_option?.value
      const provider = action.action_id === 'ccnew_folder_codex' ? 'codex' : 'claude'
      if (folder) await spawnNew(body.channel?.id, path.join(codeDir(), folder), defaultNewFlags(provider), provider)
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
    if (String(action.action_id || '').startsWith('qform_')) {
      const [, sid, n] = String(action.value || '').split(':')
      const session = state.sessions[sid]
      const o = session && qforms.get(sid)?.options.find(x => String(x.n) === n)
      if (session && o && session.tmux && (await tmuxAlive(session.tmux))) await answerQuestionForm(session, o.n, o.label)
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
      clearPermissionsForPid(s.pid, 'session process exited')
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
    clearPermissionsForPid(s.pid, 'terminal closed')
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
  let hydratedCodexEffort = false
  for (const s of Object.values(state.sessions)) {
    if (providerOf(s) === 'codex' && !s.effort) {
      const effort = resolveCodexEffort({ launchFlags: s.launchFlags, cwd: s.cwd })
      if (effort) { s.effort = effort; hydratedCodexEffort = true }
    }
    if (s.tmux && s.pid && pidAlive(s.pid)) { clearKillOnClose(s.tmux); updateTopic(s).catch(() => {}) }
  }
  if (hydratedCodexEffort) saveState(state)
  if (!state.control) {
    try {
      // Recover either identity before creating anything. This makes a missing
      // state.control field safe on upgrades and prevents duplicate channels.
      const existing = await findControlChannel(cursor => web.conversations.list({
        types: 'private_channel', limit: 200, ...(cursor ? { cursor } : {}),
      }))
      if (existing) state.control = existing.id
      else {
        const c = await web.conversations.create({ name: CONTROL_CHANNEL_NAME, is_private: true })
        state.control = c.channel.id
      }
      if (USER) { // fresh installs are unclaimed; /cc-claim invites the owner later
        try { await web.conversations.invite({ channel: state.control, users: USER }) } catch {}
        await post(state.control, '🤖 *Bridge online.* Type `/cc-` for Claude Code or `/codex-` for Codex. Start with `/cc-new` or `/codex-new`; use the matching `-help` command for the list.')
      }
    } catch (e) {
      if (e?.data?.error === 'name_taken') {
        const existing = await findControlChannel(cursor => web.conversations.list({
          types: 'private_channel', limit: 200, ...(cursor ? { cursor } : {}),
        }))
        state.control = existing?.id || null
      }
    }
    saveState(state)
  }
  await sm.start()
  log('socket mode connected — bridge ready')
  await readoptStatus() // recover live status for turns that were mid-flight on restart
  selfUpdate('boot').catch(e => log('self-update error', String(e)))
})().catch(e => { log('BOOT FAILED', e); process.exit(1) })
