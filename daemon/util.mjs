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

// Make closing the terminal window terminate the session (and claude), instead of
// leaving it running headless in a detached tmux. The hook fires on a real
// client detach (window close), not on the daemon's send-keys/capture commands.
export async function setKillOnClose(tname) {
  try { await execFile('tmux', ['set-hook', '-t', tname, 'client-detached', `kill-session -t ${tname}`]) } catch {}
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

// Reap CCS-spawned Ghostty instances whose tmux session has already ended. On
// macOS, `open -na Ghostty.app` starts a new *instance* per session; once its
// window closes the instance can linger with no windows (a "zombie"). Enough
// zombies exhaust the GPU/window-server resources and the next spawn dies with
// "terminal failed to initialize". New instances now quit themselves via
// --quit-after-last-window-closed=true (see ghosttySpawn); this sweep is the
// backstop and also cleans up instances started before that flag existed.
export async function reapZombieGhosttys() {
  let out = ''
  try { out = (await execFile('ps', ['-axo', 'pid=,command='])).stdout } catch { return }
  for (const line of out.split('\n')) {
    if (!/Ghostty\.app\/Contents\/MacOS\/ghostty/.test(line)) continue
    const pid = Number((line.match(/^\s*(\d+)\s/) || [])[1])
    const tname = (line.match(/new-session -s '(ccs-[^']+)'/) || [])[1]
    if (!pid || !tname || await tmuxAlive(tname)) continue
    try { process.kill(pid); log('reaped zombie ghostty', { pid, tname }) } catch {}
  }
}

export async function ghosttySpawn({ cwd, args, title, tmuxName, autoConsent }) {
  await reapZombieGhosttys() // free resources from dead sessions before launching
  const ccsCmd = `CCS_BRIDGE=1 CCS_TMUX=${tmuxName} ${shq(path.join(BRIDGE, 'bin', 'ccs'))} ${args.map(shq).join(' ')}`
  const inner = `mkdir -p ${shq(cwd)} && cd ${shq(cwd)} && exec tmux new-session -s ${shq(tmuxName)} ${shq(ccsCmd)}`
  // --quit-after-last-window-closed=true: each spawn is its own Ghostty instance,
  // so make it exit when its window closes. Otherwise terminated sessions leave
  // windowless instances piling up until a spawn can't get a GPU surface
  // ("terminal failed to initialize").
  await execFile('open', ['-na', 'Ghostty.app', '--args',
    '--quit-after-last-window-closed=true', `--title=${title}`, '-e', 'zsh', '-lc', inner])
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
