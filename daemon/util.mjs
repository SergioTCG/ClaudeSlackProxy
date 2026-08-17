import { execFile as _execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerCommand } from './providers.mjs'

export const execFile = promisify(_execFile)
export const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Config + state live outside the repo so updates never touch secrets/state.
// Legacy in-repo locations are still read as a fallback (and state is migrated).
export const CONFIG_DIR = process.env.CCS_CONFIG_DIR || path.join(os.homedir(), '.config', 'ccs')
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')
const LEGACY_STATE = path.join(BRIDGE, 'state.json')

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function loadEnv() {
  // Load config env first (takes precedence), then the repo .env fills any gaps.
  // Merging avoids a partial ~/.config/ccs/env masking tokens still in .env.
  const candidates = [path.join(CONFIG_DIR, 'env'), path.join(BRIDGE, '.env')]
  let found = false
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue
    found = true
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  }
  if (!found) throw new Error(`no env file found (looked in: ${candidates.join(', ')})`)
}

// ---- state ------------------------------------------------------------------
export function loadState() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  if (!fs.existsSync(STATE_FILE) && fs.existsSync(LEGACY_STATE)) {
    try { fs.copyFileSync(LEGACY_STATE, STATE_FILE) } catch {} // one-time migration
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { control: null, sessions: {}, channels: {} }
  }
}
let saveTimer = null
function writeState(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
  try { fs.chmodSync(STATE_FILE, 0o600) } catch {}
}
export function saveState(state) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; writeState(state) }, 300)
}

// Provider switches are a journaled cross-process transaction. Persist phase
// boundaries synchronously so a daemon crash can never leave state claiming the
// source is active after its terminal has already been stopped (or vice versa).
export function saveStateNow(state) {
  clearTimeout(saveTimer)
  saveTimer = null
  writeState(state)
}

// ---- processes --------------------------------------------------------------
async function psField(field, pid) {
  try {
    const { stdout } = await execFile('ps', ['-o', `${field}=`, '-p', String(pid)])
    return stdout.trim()
  } catch {
    return ''
  }
}

// Walk up from a hook process until we find the owning agent. The Claude export
// remains as a compatibility wrapper for the existing channel server paths.
export async function resolveAgentPid(start, provider = 'claude') {
  let pid = Number(start)
  const match = provider === 'codex' ? /codex/i : /claude/i
  for (let hop = 0; hop < 6 && pid > 1; hop++) {
    const comm = await psField('comm', pid)
    if (match.test(comm)) return pid
    const pp = Number(await psField('ppid', pid))
    if (!pp || pp === pid) break
    pid = pp
  }
  return Number(start) || null
}
export const resolveClaudePid = start => resolveAgentPid(start, 'claude')

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- git / naming -----------------------------------------------------------
// General git identity for ANY project (no per-repo logic):
//  - repo:     canonical name from the remote, else the main worktree's dir
//  - branch:   current branch (workflows are branch-bound)
//  - worktree: this checkout's dir name, when it differs from repo (linked worktree)
export async function gitInfo(cwd) {
  let repo = path.basename(cwd)
  let branch = ''
  let worktree = ''
  const git = async (...a) => (await execFile('git', ['-C', cwd, ...a])).stdout.trim()
  try {
    const toplevel = await git('rev-parse', '--show-toplevel')
    // repo name: prefer the remote's name, else the main repo dir (common-dir's parent)
    const commonDir = path.resolve(cwd, await git('rev-parse', '--git-common-dir'))
    repo = path.basename(path.dirname(commonDir))
    try {
      const url = await git('remote', 'get-url', 'origin')
      const m = url.replace(/\.git$/, '').match(/([^/:]+)$/)
      if (m) repo = m[1]
    } catch {}
    // a linked worktree's git-dir differs from the shared common-dir
    const gitDir = path.resolve(await git('rev-parse', '--absolute-git-dir'))
    if (gitDir !== commonDir) worktree = path.basename(toplevel)
    branch = await git('branch', '--show-current')
  } catch {}
  return { repo, branch, worktree }
}

export async function gitStatusText(cwd) {
  try { return (await execFile('git', ['-C', cwd, 'status', '--short'])).stdout.trim() } catch { return '' }
}

export async function gitBranch(cwd) {
  // --show-current handles an unborn branch (fresh repo, no commits); rev-parse HEAD doesn't.
  try { return (await execFile('git', ['-C', cwd, 'branch', '--show-current'])).stdout.trim() } catch { return '' }
}

export function channelName(repo, branch, worktree) {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  // repo + branch is the recognizable core; worktree name only fills in for a
  // detached HEAD (no branch). The full cwd lives in the channel topic either way.
  const base = [repo, branch || worktree, stamp].filter(Boolean).join('-')
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').slice(0, 75)
}

// ---- tmux / ghostty ---------------------------------------------------------
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

export async function tmuxAlive(tname) {
  try { await execFile('tmux', ['has-session', '-t', tname]); return true } catch { return false }
}

export async function tmuxAttached(tname) {
  try { return (await execFile('tmux', ['list-clients', '-t', tname])).stdout.trim().length > 0 } catch { return false }
}

export async function tmuxKill(tname) {
  try { await execFile('tmux', ['kill-session', '-t', tname]) } catch {}
}

export async function tmuxCapture(tname) {
  try { return (await execFile('tmux', ['capture-pane', '-t', tname, '-p'])).stdout } catch { return '' }
}

// Ensure a session does NOT die when its terminal window closes. We used to set a
// client-detached → kill-session hook (so closing the window ended claude), but
// Ghostty 1.3.1 runs single-instance: any `open -na` spawn re-initializes the one
// shared instance and closes *every* window at once, which made that hook cascade
// into killing all live sessions. So we now actively remove the hook — a closed
// window just leaves claude running headless in tmux (the daemon still drives it,
// and Slack still works). Intentional termination is `/cc-kill`.
export async function clearKillOnClose(tname) {
  try { await execFile('tmux', ['set-hook', '-u', '-t', tname, 'client-detached']) } catch {}
}

// Let tmux own the outer terminal title and pin it to a literal string (mirrors
// the Slack channel topic: folder · branch · model · effort). '#' is escaped so
// tmux never interprets format directives in branch/path names.
export async function tmuxTitle(tname, text) {
  try {
    await execFile('tmux', ['set-option', '-t', tname, 'set-titles', 'on'])
    await execFile('tmux', ['set-option', '-t', tname, 'set-titles-string', String(text).replace(/#/g, '##')])
  } catch {}
}

// Codex's launcher binds F12 to interrupt_turn, avoiding Ctrl-C's idle/exit
// ambiguity. Claude retains its established Escape behavior.
export async function tmuxInterrupt(tname, provider = 'claude') {
  await execFile('tmux', ['send-keys', '-t', tname, provider === 'codex' ? 'F12' : 'Escape'])
}

// Inject a full message into the session's input box as a bracketed paste,
// then submit. Unlike channel events (rendered as a ~50-char summary line),
// this shows the complete message in the terminal exactly as if typed.
export async function tmuxPaste(tname, text) {
  await execFile('tmux', ['set-buffer', '-b', 'ccs-inject', text])
  await execFile('tmux', ['paste-buffer', '-p', '-d', '-b', 'ccs-inject', '-t', tname])
  await sleep(300)
  await execFile('tmux', ['send-keys', '-t', tname, 'Enter'])
}

export async function tmuxSendCommand(tname, slashCommand) {
  await execFile('tmux', ['send-keys', '-t', tname, '-l', slashCommand])
  await sleep(150)
  await execFile('tmux', ['send-keys', '-t', tname, 'Enter'])
}

// Reap windowless Ghostty zombies. Ghostty runs one process per window; an
// instance whose window failed to initialize (or whose session ended before
// --quit-after-last-window-closed existed) lingers with no window, and ~5+ live
// instances make the NEXT window fail to initialize ("Oh, no" wedge). Only
// instances whose tmux is dead AND that are older than minAgeSec are killed —
// the age gate makes the fatal 0.2.8-era init-race (reaping a spawn still
// materializing) impossible: a real zombie is minutes old, a starting one is
// seconds old.
export async function reapGhosttyZombies(minAgeSec = 60) {
  let out = ''
  try { out = (await execFile('ps', ['-axo', 'pid=,etime=,command='])).stdout } catch { return 0 }
  let reaped = 0
  for (const line of out.split('\n')) {
    if (!/Ghostty\.app\/Contents\/MacOS\/ghostty/.test(line)) continue
    const m = line.match(/^\s*(\d+)\s+([\d:.-]+)\s/)
    const tname = (line.match(/new-session -s '(ccs-[^']+)'/) || [])[1]
    if (!m || !tname) continue
    // etime: [[dd-]hh:]mm:ss
    const p = m[2].split('-'); const days = p.length > 1 ? Number(p[0]) : 0
    const hms = p[p.length - 1].split(':').map(Number)
    while (hms.length < 3) hms.unshift(0)
    const age = days * 86400 + hms[0] * 3600 + hms[1] * 60 + hms[2]
    if (age < minAgeSec || await tmuxAlive(tname)) continue
    try { process.kill(Number(m[1])); reaped++; log('reaped windowless ghostty', { pid: Number(m[1]), tname, age }) } catch {}
  }
  return reaped
}

// Environment for anything handed to `open`: strip bridge and Claude identity
// vars so windows/shells opened inside spawned instances can't inherit another
// session's identity (the root of the cross-session routing corruption).
function sanitizedEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CCS_|CLAUDE|ANTHROPIC_)/.test(k)) delete env[k]
  for (const k of ['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SESSION_ID']) delete env[k]
  return env
}

// ---- single-icon mode (CCS_GHOSTTY_SINGLE=1) --------------------------------
// One dedicated Ghostty instance hosts ALL bridge windows: its `command` is the
// ccs-window dispatcher, so every new window (ours via a scripted File→New
// Window click, or the user's own Cmd+N) pops the next pending session from the
// spool and attaches to it. One Dock icon, right-click lists every session.
const SPOOL_DIR = path.join(CONFIG_DIR, 'window-spool')

// How many windows an instance currently has. -1 when it can't be determined
// (no Accessibility permission etc.), which callers treat as "assume usable".
async function instanceWindowCount(pid) {
  try {
    const { stdout } = await execFile('osascript', ['-e',
      `tell application "System Events" to count windows of (first application process whose unix id is ${pid})`],
      { timeout: 8000 })
    const n = Number(String(stdout).trim())
    return Number.isFinite(n) ? n : -1
  } catch { return -1 }
}

export async function findBridgeInstance() {
  let pid = null
  try {
    const out = (await execFile('ps', ['-axo', 'pid=,command='])).stdout
    for (const line of out.split('\n')) {
      if (/Ghostty\.app\/Contents\/MacOS\/ghostty/.test(line) && line.includes('bin/ccs-window')) {
        const p = Number(line.match(/^\s*(\d+)/)?.[1]) || null
        if (p) { try { process.kill(p, 0); pid = p; break } catch {} } // stale ps rows happen
      }
    }
  } catch {}
  if (!pid) return null
  // A windowless instance cannot be driven: File → New Window "succeeds" (the
  // script even returns the menu item) but nothing opens, so every request
  // silently no-ops. Reap it and report absent, so the caller relaunches an
  // instance — which opens a window and consumes the spool immediately.
  if ((await instanceWindowCount(pid)) === 0) {
    try { process.kill(pid); log('reaped windowless bridge instance', pid) } catch {}
    return null
  }
  return pid
}

export async function requestBridgeWindow(tmuxName, title) {
  fs.mkdirSync(SPOOL_DIR, { recursive: true })
  const spoolFile = path.join(SPOOL_DIR, `${Date.now()}-${tmuxName}`)
  fs.writeFileSync(spoolFile, `${tmuxName}\t${title}\n`)
  const pid = await findBridgeInstance()
  if (!pid) {
    // First window: launching the instance consumes the spool entry directly.
    // NB: no --title here — Ghostty's `title` config PINS every window's title,
    // which would override the per-session titles the dispatcher sets.
    await execFile('open', ['-na', 'Ghostty.app', '--args',
      `--command=${path.join(BRIDGE, 'bin', 'ccs-window')}`,
      '--quit-after-last-window-closed=true'], { env: sanitizedEnv() })
    log('bridge ghostty instance launched (single-icon mode)')
    return true
  }
  try {
    // Subsequent windows: one scripted menu click on the running instance.
    // Requires Accessibility permission for the daemon's node binary.
    const script = `tell application "System Events"
  set p to first application process whose unix id is ${pid}
  set frontmost of p to true
  delay 0.2
  click menu item "New Window" of menu 1 of menu bar item "File" of menu bar 1 of p
end tell`
    await execFile('osascript', ['-e', script], { timeout: 10000 })
  } catch (e) {
    try { fs.unlinkSync(spoolFile) } catch {} // never leave a stale claim behind
    log('single-icon window click failed (Accessibility?):', String(e?.stderr || e?.message || e).slice(0, 140))
    return false
  }
  // A click that throws no error still may not produce a window (this is UI
  // scripting). Verify the terminal actually appeared; otherwise reclaim the
  // request and report failure so the caller can fall back to its own instance.
  for (let i = 0; i < 12; i++) {
    await sleep(1000)
    if (await tmuxAttached(tmuxName)) return true
  }
  try { fs.unlinkSync(spoolFile) } catch {}
  log('bridge window never materialized for', tmuxName, '— falling back')
  return false
}

// Account names are interpolated into a shell command, so they are strictly
// validated here as well as at the CLI — never trust a stored value blindly.
export const safeAccount = a => (typeof a === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(a) ? a : null)

export async function ghosttySpawn({ cwd, args, title, tmuxName, autoConsent, account, provider = 'claude' }) {
  const acct = provider === 'claude' ? safeAccount(account) : null
  const launcher = provider === 'codex' ? 'sab-codex' : 'sab-cc'
  // Only the NAME travels in the command line (ps is world-readable); `sab-cc`
  // resolves it to the token from the 0600 accounts file.
  const launcherCmd = `CCS_BRIDGE=1 CCS_TMUX=${tmuxName}${provider === 'codex' ? ' CCS_PROVIDER=codex' : ''}${acct ? ` CCS_ACCOUNT=${acct}` : ''} ${shq(path.join(BRIDGE, 'bin', launcher))} ${args.map(shq).join(' ')}`
  if (process.env.CCS_GHOSTTY_SINGLE === '1') {
    // Single-icon mode: the daemon owns the tmux session (created detached);
    // windows are just viewports requested from the one bridge instance.
    // Detached boots have died mid-startup on rare races (consent dialogs /
    // claude self-relaunch), silently producing nothing — so babysit the boot:
    // verify claude reaches its prompt, capture the last screen if the tmux
    // dies (forensics for the next occurrence), and retry once. The viewport is
    // requested only after claude is ready, removing mid-boot attach races.
    fs.mkdirSync(cwd, { recursive: true })
    let ready = false
    for (let attempt = 1; attempt <= 2 && !ready; attempt++) {
      await execFile('tmux', ['new-session', '-d', '-s', tmuxName, '-c', cwd, launcherCmd])
      log('spawned detached tmux', { cwd, args, tmuxName, attempt })
      if (autoConsent) {
        const c = spawn(path.join(BRIDGE, 'bin', 'ccs-consent'), [tmuxName], { detached: true, stdio: 'ignore' })
        c.unref()
      }
      let lastPane = ''
      for (let i = 0; i < 60 && !ready; i++) {
        await sleep(500)
        if (!(await tmuxAlive(tmuxName))) {
          log(`boot died (attempt ${attempt}); last screen:`, JSON.stringify(lastPane.split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400)))
          break
        }
        const pane = await tmuxCapture(tmuxName)
        if (pane.trim()) lastPane = pane
        const readyPattern = provider === 'codex'
          ? /codex|openai|review hooks|what would you like/i
          : /bypass permissions|shift\+tab to cycle/
        if (readyPattern.test(pane)) ready = true
      }
      if (!ready && (await tmuxAlive(tmuxName))) { ready = true; log('boot verification timed out but tmux alive — proceeding', tmuxName) }
    }
    if (!ready) throw new Error(`spawn failed twice for ${tmuxName} — see daemon log for last screen`)
    if (!(await requestBridgeWindow(tmuxName, title))) {
      await execFile('open', ['-na', 'Ghostty.app', '--args',
        '--quit-after-last-window-closed=true',
        '-e', 'zsh', '-lc', `exec tmux attach-session -t ${tmuxName}`], { env: sanitizedEnv() })
      log('fell back to dedicated attach instance for', tmuxName)
    }
    if (autoConsent) return // consent watcher already launched per attempt
  } else {
    const inner = `mkdir -p ${shq(cwd)} && cd ${shq(cwd)} && exec tmux new-session -s ${shq(tmuxName)} ${shq(launcherCmd)}`
    // One Ghostty process per window. --quit-after-last-window-closed makes the
    // instance exit when its window closes, so ended sessions don't pile up as
    // windowless instances (enough of those and new windows fail to initialize).
    // Optional: CCS_GHOSTTY_HIDDEN=1 spawns accessory (dockless) instances.
    const hidden = process.env.CCS_GHOSTTY_HIDDEN === '1' ? ['--macos-hidden=always'] : []
    // No --title here on purpose: Ghostty's `title` config PINS the window title
    // and ignores the escape sequences tmux sends, which is how the window title
    // mirrors the Slack channel topic (see tmuxTitle/updateTopic).
    await execFile('open', ['-na', 'Ghostty.app', '--args', ...hidden,
      '--quit-after-last-window-closed=true', '-e', 'zsh', '-lc', inner], { env: sanitizedEnv() })
    log('spawned ghostty', { provider: providerCommand(provider), cwd, args, tmuxName })
  }
  if (autoConsent) {
    // Nobody is at the Mac: smart-dismiss the trust / dev-channels dialogs when
    // they actually appear (safer than blind timed Enter presses).
    const child = spawn(path.join(BRIDGE, 'bin', 'ccs-consent'), [tmuxName], {
      detached: true, stdio: 'ignore',
    })
    child.unref()
  }
}

// Enumerate the model families this `claude` build supports, each mapped to its
// latest version. The native install is a single executable with the model ids
// embedded, so we read them straight from the binary — the list stays correct
// across `claude update` with nothing hardcoded.
export async function availableModels(bin) {
  const families = ['opus', 'sonnet', 'haiku', 'fable']
  let out = ''
  try {
    // `(\[1m\])?` also captures the long-context variants (e.g. claude-opus-5[1m]),
    // which are separate model ids the plain family alias never selects.
    out = (await execFile('grep', ['-aoE', `claude-(${families.join('|')})-[0-9][a-z0-9-]*(\\[1m\\])?`, bin],
      { maxBuffer: 8 << 20, timeout: 8000 })).stdout
  } catch { return [] } // grep exits non-zero on no match / unreadable binary → caller falls back
  const ids = [...new Set(out.split('\n').filter(Boolean))]
  const models = []
  for (const fam of families) {
    const pre = `claude-${fam}-`
    const clean = ids
      .filter(id => new RegExp(`^${pre}\\d+(?:-\\d+)*$`).test(id))      // plain versions only
      .filter(id => !id.slice(pre.length).split('-').some(s => s.length >= 6)) // drop dated snapshots
    if (!clean.length) continue
    const nums = id => id.slice(pre.length).split('-').map(Number)
    clean.sort((a, b) => { const A = nums(a), B = nums(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d } return 0 })
    const id = clean[clean.length - 1]
    const Fam = fam[0].toUpperCase() + fam.slice(1)
    const ver = id.slice(pre.length).replace(/-/g, '.')
    models.push({ alias: fam, id, name: `${Fam} ${ver}` })
    // Long-context sibling, when this build has one: a distinct id, so it needs
    // its own alias — the family alias always resolves to the standard variant.
    if (ids.includes(`${id}[1m]`)) models.push({ alias: `${fam}-1m`, id: `${id}[1m]`, name: `${Fam} ${ver} (1M context)` })
  }
  return models
}
