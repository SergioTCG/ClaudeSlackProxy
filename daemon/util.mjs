import { execFile as _execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const execFile = promisify(_execFile)
export const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = path.join(BRIDGE, 'state.json')

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function loadEnv() {
  const f = path.join(BRIDGE, '.env')
  if (!fs.existsSync(f)) throw new Error('.env missing at repo root')
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

// ---- state ------------------------------------------------------------------
export function loadState() {
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
export async function gitInfo(cwd) {
  let repo = path.basename(cwd)
  let branch = ''
  try {
    const { stdout: top } = await execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'])
    repo = path.basename(top.trim())
    const { stdout: br } = await execFile('git', ['-C', cwd, 'branch', '--show-current'])
    branch = br.trim()
  } catch {}
  return { repo, branch }
}

export function channelName(repo, branch) {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const base = [repo, branch, stamp].filter(Boolean).join('-')
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').slice(0, 75)
}

// ---- tmux / ghostty ---------------------------------------------------------
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

export async function tmuxAlive(tname) {
  try { await execFile('tmux', ['has-session', '-t', tname]); return true } catch { return false }
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

export async function ghosttySpawn({ cwd, args, title, tmuxName, autoConsent }) {
  const ccsCmd = `CCS_BRIDGE=1 CCS_TMUX=${tmuxName} ${shq(path.join(BRIDGE, 'bin', 'ccs'))} ${args.map(shq).join(' ')}`
  const inner = `cd ${shq(cwd)} && exec tmux new-session -s ${shq(tmuxName)} ${shq(ccsCmd)}`
  await execFile('open', ['-na', 'Ghostty.app', '--args', `--title=${title}`, '-e', 'zsh', '-lc', inner])
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
