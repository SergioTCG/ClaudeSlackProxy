import { execFile as _execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
export function saveState(state) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, STATE_FILE)
  }, 300)
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

// Walk up from `start` until we find the owning `claude` process.
export async function resolveClaudePid(start) {
  let pid = Number(start)
  for (let hop = 0; hop < 6 && pid > 1; hop++) {
    const comm = await psField('comm', pid)
    if (/claude/i.test(comm)) return pid
    const pp = Number(await psField('ppid', pid))
    if (!pp || pp === pid) break
    pid = pp
  }
  return Number(start) || null
}

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

// Send Escape — Claude Code's interrupt key — to abort the running turn.
export async function tmuxInterrupt(tname) {
  await execFile('tmux', ['send-keys', '-t', tname, 'Escape'])
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

export async function ghosttySpawn({ cwd, args, title, tmuxName, autoConsent }) {
  const ccsCmd = `CCS_BRIDGE=1 CCS_TMUX=${tmuxName} ${shq(path.join(BRIDGE, 'bin', 'ccs'))} ${args.map(shq).join(' ')}`
  const inner = `mkdir -p ${shq(cwd)} && cd ${shq(cwd)} && exec tmux new-session -s ${shq(tmuxName)} ${shq(ccsCmd)}`
  // One Ghostty process per window. --quit-after-last-window-closed makes the
  // instance exit when its window closes, so ended sessions don't pile up as
  // windowless instances (enough of those and new windows fail to initialize).
  // Safe now that closing a window no longer kills sessions via tmux hooks —
  // the flag only ever quits the instance it launches.
  // Optional: CCS_GHOSTTY_HIDDEN=1 runs each spawned instance as an accessory
  // app — windows stay fully visible and clickable but add no Dock icon or
  // Cmd-Tab entry. Default is normal Dock presence (one icon per session,
  // since each window is its own instance).
  const hidden = process.env.CCS_GHOSTTY_HIDDEN === '1' ? ['--macos-hidden=always'] : []
  // Strip bridge vars from the environment `open` hands the instance: a window
  // opened later inside it (Cmd+N, scripts) must not inherit another session's
  // CCS_TMUX/CCS_FLAGS — that's how one session's channel ended up pasting into
  // a different session's terminal.
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CCS_|CLAUDE|ANTHROPIC_)/.test(k)) delete env[k]
  await execFile('open', ['-na', 'Ghostty.app', '--args', ...hidden,
    '--quit-after-last-window-closed=true', `--title=${title}`, '-e', 'zsh', '-lc', inner], { env })
  log('spawned ghostty', { cwd, args, tmuxName })
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
    out = (await execFile('grep', ['-aoE', `claude-(${families.join('|')})-[0-9][a-z0-9-]*`, bin],
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
    models.push({ alias: fam, id, name: `${fam[0].toUpperCase()}${fam.slice(1)} ${id.slice(pre.length).replace(/-/g, '.')}` })
  }
  return models
}
