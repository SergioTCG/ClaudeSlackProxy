import fs from 'node:fs'
import path from 'node:path'

export const PROVIDERS = Object.freeze(['claude', 'codex'])

export function normalizeProvider(value, fallback = 'claude') {
  const provider = String(value || fallback).toLowerCase()
  return PROVIDERS.includes(provider) ? provider : null
}

// Old state records intentionally have no provider field. Treating that shape
// as Claude keeps existing state backward-compatible and avoids a risky bulk
// migration of the live bridge state file.
export function providerOf(session) {
  return session?.provider === 'codex' ? 'codex' : 'claude'
}

export const providerLabel = provider => provider === 'codex' ? 'Codex' : 'Claude Code'
export const providerCommand = provider => provider === 'codex' ? 'codex' : 'claude'
export const slackCommand = (provider, name) => `/${provider === 'codex' ? 'codex' : 'cc'}-${name}`

export function parseSlackCommand(command) {
  const match = /^\/(cc|codex)-([a-z][a-z0-9-]*)$/.exec(String(command || ''))
  if (!match) return null
  return {
    provider: match[1] === 'codex' ? 'codex' : 'claude',
    name: match[2],
  }
}

export const acceptHookSettings = (event, isRestarting) =>
  !isRestarting || event === 'SessionStart'

export const isSupersededHook = (event, storedPid, eventPid) =>
  event !== 'SessionStart' && Boolean(storedPid) && Number(storedPid) !== Number(eventPid)

const CLAUDE_FLAGS = new Set([
  '--dangerously-skip-permissions', '--chrome', '--continue', '--model', '--effort',
])
const CLAUDE_ALIASES = Object.freeze({ '--dsp': '--dangerously-skip-permissions' })

export const CODEX_DANGEROUS_FLAG = '--dangerously-bypass-approvals-and-sandbox'
const CODEX_ALIASES = Object.freeze({ '--yolo': CODEX_DANGEROUS_FLAG })

// Keep Codex launch flags deliberately narrow. Values use --name=value so Slack
// tokenization cannot accidentally turn a value into an unvalidated argument.
const CODEX_FLAGS = new Set([
  '--search', '--no-alt-screen', '--approve-for-me',
  CODEX_DANGEROUS_FLAG,
])
const CODEX_VALUE_FLAGS = [
  '--model=', '--sandbox=', '--ask-for-approval=',
]

export function allowedFlags(provider) {
  return provider === 'codex'
    ? [...CODEX_FLAGS, ...CODEX_VALUE_FLAGS.map(f => f + '<value>')]
    : [...CLAUDE_FLAGS]
}

export function normalizeLaunchFlag(provider, flag) {
  const raw = String(flag || '')
  if (provider === 'claude') {
    const normalized = CLAUDE_ALIASES[raw] || raw
    return CLAUDE_FLAGS.has(normalized.split('=')[0]) ? normalized : null
  }
  const normalized = CODEX_ALIASES[raw] || raw
  if (CODEX_FLAGS.has(normalized)) return normalized
  return CODEX_VALUE_FLAGS.some(prefix => normalized.startsWith(prefix) && normalized.length > prefix.length)
    ? normalized
    : null
}

export function defaultNewFlagsFor(provider, env = process.env) {
  const configured = provider === 'codex'
    ? env.CCS_CODEX_NEW_FLAGS || CODEX_DANGEROUS_FLAG
    : env.CCS_NEW_FLAGS || '--dangerously-skip-permissions'
  return String(configured).split(/\s+/).filter(Boolean)
}

// `codex resume [flags] <session-id> [prompt]` may carry the first queued Slack
// message as its optional prompt. CCS_FLAGS is metadata for future resumes, so
// persist only through the session-id token; otherwise prompt words become
// bogus launch flags the next time the conversation wakes.
export function codexFlagsWithoutInitialPrompt(flags, sessionId) {
  const raw = String(flags || '')
  const sid = String(sessionId || '')
  if (!sid) return raw
  const escaped = sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).exec(raw)
  return match ? raw.slice(0, match.index + match[0].length).trim() : raw
}

export function displayFlagsFor(session) {
  const provider = providerOf(session)
  const toks = String(session?.launchFlags || '').trim().split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (provider === 'claude') {
      if (t === '--resume' || t === '-r') { i++; continue }
      if (t === '--continue' || t === '-c') continue
    } else if (t === 'resume') {
      continue
    }
    out.push(t)
  }
  if (provider === 'codex' && out[out.length - 1] === session?.id) out.pop()
  return out
}

const tomlString = value => JSON.stringify(String(value))

export function resumeArgsFor(session, {
  defaultClaudeFlags = '--dangerously-skip-permissions', defaultCodexFlags = CODEX_DANGEROUS_FLAG,
  initialPrompt = null,
} = {}) {
  const provider = providerOf(session)
  const toks = displayFlagsFor(session)
  if (provider === 'claude') {
    const keep = []
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (t === '--effort') { i++; continue }
      keep.push(t)
    }
    if (!keep.length) keep.push(...String(defaultClaudeFlags).split(/\s+/).filter(Boolean))
    if (session.effort) keep.push('--effort', session.effort)
    return [...keep, '--resume', session.id]
  }

  const keep = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t === '-m' || t === '--model' || t === '-C' || t === '--cd') { i++; continue }
    if (t.startsWith('--model=') || t.startsWith('--cd=')) continue
    if (t === '-c' || t === '--config') {
      const value = toks[++i]
      if (value && !/^model_reasoning_effort=/.test(value)) keep.push(t, value)
      continue
    }
    if (t.startsWith('--config=model_reasoning_effort=')) continue
    keep.push(t)
  }
  if (!keep.length) keep.push(...String(defaultCodexFlags).split(/\s+/).filter(Boolean))
  if (session.model) keep.push('--model', session.model)
  if (session.effort) keep.push('--config', `model_reasoning_effort=${tomlString(session.effort)}`)
  const args = ['resume', ...keep, session.id]
  if (initialPrompt) args.push(String(initialPrompt))
  return args
}

// Provider switches never translate flags, accounts, models, or effort across
// providers. A returning native leg resumes with its own settings; a first-time
// leg receives only that provider's configured new-session defaults.
export function switchTargetLaunch(provider, targetSession = null, env = process.env) {
  if (targetSession) {
    if (providerOf(targetSession) !== provider) throw new Error('switch target provider mismatch')
    const args = resumeArgsFor(targetSession, {
      defaultClaudeFlags: env.CCS_RESUME_FLAGS || '--dangerously-skip-permissions',
      defaultCodexFlags: env.CCS_CODEX_RESUME_FLAGS || CODEX_DANGEROUS_FLAG,
    })
    return { kind: 'resume', args, effectiveFlags: displayFlagsFor(targetSession) }
  }
  const args = defaultNewFlagsFor(provider, env)
  return { kind: 'new', args, effectiveFlags: [...args] }
}

// Slack requires action_id to be unique within an actions block. Keep the
// action name in both the identifier and value: the identifier satisfies Block
// Kit validation, while the signed interaction payload still carries the
// transition id used to reject stale clicks.
export function switchActionBlocks(transition, preflight, stage = 'preview') {
  const actions = []
  const button = (text, action, style) => ({
    type: 'button', text: { type: 'plain_text', text }, action_id: `provider_switch_${action}`,
    value: `switch:${transition.id}:${action}`, ...(style ? { style } : {}),
  })
  if (stage === 'proposal') actions.push(button('Apply and switch', 'apply', 'primary'), button('Switch without applying', 'continue'))
  else {
    if (preflight.safeToPropose) actions.push(button('Align instructions', 'align', 'primary'))
    actions.push(button(`Switch to ${providerLabel(transition.target.provider)}`, 'continue', preflight.safeToPropose ? undefined : 'primary'))
  }
  actions.push(button('Cancel', 'cancel', 'danger'))
  return [{ type: 'actions', block_id: `provider_switch_${transition.id}`, elements: actions }]
}

export function codexPermissionDecision(behavior) {
  const decision = { behavior }
  if (behavior === 'deny') decision.message = 'Denied from Slack.'
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}

export const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// Codex's hook payload includes the active model, but currently omits reasoning
// effort. Resolve that one missing value from the same launch/config inputs the
// CLI uses instead of reading Codex's unstable session JSONL at runtime.
const CODEX_CONFIG_EFFORTS = new Set(['minimal', ...CODEX_EFFORTS])

function normalizeCodexEffort(value) {
  let effort = String(value || '').trim()
  if ((effort.startsWith('"') && effort.endsWith('"')) ||
      (effort.startsWith("'") && effort.endsWith("'"))) effort = effort.slice(1, -1)
  effort = effort.trim().toLowerCase()
  return CODEX_CONFIG_EFFORTS.has(effort) ? effort : null
}

// Read a scalar from the TOML root or one named table. This intentionally is a
// tiny, narrow reader: reasoning effort and profile names are simple strings,
// and accepting arbitrary TOML here would add a parser to the daemon's trusted
// surface for no benefit.
function codexTomlScalar(text, key, table = '') {
  let current = ''
  let value = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const heading = raw.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/)
    if (heading) { current = heading[1].trim(); continue }
    if (current !== table) continue
    const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*("[^"]*"|'[^']*'|[^#\\s]+)\\s*(?:#.*)?$`))
    if (match) value = match[1]
  }
  return value
}

export function codexEffortFromToml(text, table = '') {
  return normalizeCodexEffort(codexTomlScalar(text, 'model_reasoning_effort', table))
}

export function codexEffortFromArgs(flags) {
  let effort = null
  // CCS_FLAGS preserves the original argv as a string. Match both supported
  // config spellings, retaining the last override just as the CLI does.
  const re = /(?:^|\s)(?:-c|--config)(?:=|\s+)(?:["']?model_reasoning_effort\s*=\s*)("[^"]*"|'[^']*'|[^\s"']+)/g
  for (const match of String(flags || '').matchAll(re)) effort = normalizeCodexEffort(match[1]) || effort
  return effort
}

function codexProfileFromArgs(flags) {
  let profile = null
  const re = /(?:^|\s)(?:-p|--profile)(?:=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/g
  for (const match of String(flags || '').matchAll(re)) profile = String(match[1]).replace(/^["']|["']$/g, '')
  return profile
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function projectConfigFiles(cwd) {
  if (!cwd) return []
  let cursor = path.resolve(cwd)
  let projectRoot = null
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.git'))) { projectRoot = cursor; break }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (!projectRoot) return [path.join(path.resolve(cwd), '.codex', 'config.toml')]
  const dirs = []
  cursor = path.resolve(cwd)
  for (;;) {
    dirs.push(cursor)
    if (cursor === projectRoot) break
    cursor = path.dirname(cursor)
  }
  return dirs.reverse().map(dir => path.join(dir, '.codex', 'config.toml'))
}

export function resolveCodexEffort({ launchFlags = '', cwd, home = process.env.HOME,
  codexHome = process.env.CODEX_HOME } = {}) {
  const explicit = codexEffortFromArgs(launchFlags)
  const configHome = codexHome || (home ? path.join(home, '.codex') : null)
  const userConfig = configHome ? readText(path.join(configHome, 'config.toml')) : ''

  // Low → high precedence: user config, selected profile, project configs, CLI.
  // System/admin configuration is intentionally left to Codex itself; it can
  // constrain the CLI but is not a portable source the user bridge can inspect.
  let effort = codexEffortFromToml(userConfig)
  const profile = codexProfileFromArgs(launchFlags)
  if (profile) effort = codexEffortFromToml(userConfig, `profiles.${profile}`) || effort
  for (const file of projectConfigFiles(cwd)) effort = codexEffortFromToml(readText(file)) || effort
  return explicit || effort
}

export function isPathWithin(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
