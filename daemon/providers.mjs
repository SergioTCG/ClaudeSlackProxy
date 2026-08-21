import fs from 'node:fs'
import path from 'node:path'

export const PROVIDERS = Object.freeze(['claude', 'codex', 'pi'])

const PROVIDER_META = Object.freeze({
  claude: Object.freeze({ label: 'Claude Code', command: 'claude', slackPrefix: 'cc' }),
  codex: Object.freeze({ label: 'Codex', command: 'codex', slackPrefix: 'codex' }),
  pi: Object.freeze({ label: 'Pi', command: 'pi', slackPrefix: 'pi' }),
})

export function normalizeProvider(value, fallback = 'claude') {
  const provider = String(value || fallback).toLowerCase()
  return PROVIDERS.includes(provider) ? provider : null
}

// Old state records intentionally have no provider field. Treating that shape
// as Claude keeps existing state backward-compatible and avoids a risky bulk
// migration of the live bridge state file.
export function providerOf(session) {
  return session?.provider === 'codex' || session?.provider === 'pi' ? session.provider : 'claude'
}

export const providerLabel = provider => PROVIDER_META[normalizeProvider(provider)]?.label || 'Claude Code'
export const providerCommand = provider => PROVIDER_META[normalizeProvider(provider)]?.command || 'claude'
export const slackCommand = (provider, name) => `/${PROVIDER_META[normalizeProvider(provider)]?.slackPrefix || 'cc'}-${name}`

export function parseSlackCommand(command) {
  const match = /^\/(cc|codex|pi)-([a-z][a-z0-9-]*)$/.exec(String(command || ''))
  if (!match) return null
  return {
    provider: match[1] === 'cc' ? 'claude' : match[1],
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

// Pi's built-in tools are unrestricted by default. `--approve` controls only
// project-local resources; `--safe` is consumed by sab-pi and enables the SAB
// extension's Slack permission gate. Remote values remain inline so a value can
// never be reinterpreted as another option after Slack tokenization.
const PI_FLAGS = new Set(['--approve', '--no-approve', '--offline', '--safe'])
const PI_VALUE_FLAGS = ['--provider=', '--model=', '--thinking=']

export function allowedFlags(provider) {
  if (provider === 'codex') return [...CODEX_FLAGS, ...CODEX_VALUE_FLAGS.map(f => f + '<value>')]
  if (provider === 'pi') return [...PI_FLAGS, ...PI_VALUE_FLAGS.map(f => f + '<value>')]
  return [...CLAUDE_FLAGS]
}

export function normalizeLaunchFlag(provider, flag) {
  const raw = String(flag || '')
  if (provider === 'claude') {
    const normalized = CLAUDE_ALIASES[raw] || raw
    return CLAUDE_FLAGS.has(normalized.split('=')[0]) ? normalized : null
  }
  if (provider === 'pi') {
    if (PI_FLAGS.has(raw)) return raw
    if (raw.startsWith('--thinking=')) return PI_EFFORTS.includes(raw.slice('--thinking='.length)) ? raw : null
    return PI_VALUE_FLAGS.some(prefix => raw.startsWith(prefix) && raw.length > prefix.length)
      ? raw
      : null
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
    : provider === 'pi'
      ? env.CCS_PI_NEW_FLAGS || ''
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
    } else if (provider === 'codex' && t === 'resume') {
      continue
    } else if (provider === 'pi' && (t === '--session' || t === '-s')) {
      i++; continue
    }
    out.push(t)
  }
  if (provider === 'codex' && out[out.length - 1] === session?.id) out.pop()
  return out
}

const tomlString = value => JSON.stringify(String(value))

export function resumeArgsFor(session, {
  defaultClaudeFlags = '--dangerously-skip-permissions', defaultCodexFlags = CODEX_DANGEROUS_FLAG,
  defaultPiFlags = '',
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

  if (provider === 'pi') {
    const keep = []
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (t === '--model' || t === '--provider' || t === '--thinking') { i++; continue }
      if (t.startsWith('--model=') || t.startsWith('--provider=') || t.startsWith('--thinking=')) continue
      keep.push(t)
    }
    if (!keep.length) keep.push(...String(defaultPiFlags).split(/\s+/).filter(Boolean))
    if (session.model) keep.push(`--model=${session.model}`)
    if (session.effort) keep.push(`--thinking=${session.effort}`)
    return [...keep, '--session', session.id]
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
      defaultPiFlags: env.CCS_PI_RESUME_FLAGS || '',
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

const stripTerminalControls = value => String(value || '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '')

// A tmux session exists before an interactive agent is ready to accept input.
// Inspect only the visible bottom of the pane: trust text may remain above the
// live Codex UI in scrollback, while the model/effort/path footer proves that
// the normal input surface has materialized.
export function targetStartupState(provider, pane) {
  const rendered = stripTerminalControls(pane).split('\n')
  while (rendered.length && !rendered.at(-1).trim()) rendered.pop()
  const lines = rendered.slice(-16)
  const visible = lines.join('\n')
  if (provider === 'codex') {
    const prompt = lines.some(line => /^\s*[›❯>]\s/.test(line))
    const footer = lines.some(line => /[·•].*(?:~\/|\/)[^\s]*/.test(line))
    if (prompt && footer && !/esc to interrupt|ctrl-c to interrupt/i.test(visible)) return 'ready'
    if (/do you trust|trust the (?:contents|directory|folder|workspace|project)|(?:review|trust|approve|enable).{0,80}hooks?/i.test(visible)) return 'trust'
    return 'starting'
  }
  if (provider === 'pi') {
    if (/trust|approve project|project resources/i.test(visible)) return 'trust'
    return 'starting' // Pi readiness is its authenticated native extension stream.
  }
  if (/shift\+tab to cycle|bypass permissions/i.test(visible) && /(?:^|\n)\s*[❯>]\s*/.test(visible)) return 'ready'
  if (/trust|development channels|approve/i.test(visible)) return 'trust'
  return 'starting'
}

export function codexStatusRecoveryDecision(session, pane) {
  if (!session?.codexTurnStartedAt) return 'clear'
  return targetStartupState('codex', pane) === 'ready' ? 'clear' : 'resume'
}

// Codex normally emits Stop when a turn finishes, but an operator interrupt can
// return the TUI to its input surface without that hook. Reconcile only the turn
// that was active when the interrupt was requested: a newer timestamp means a
// subsequent prompt already started and must retain its own status/poller.
export async function waitForCodexInterrupt(session, {
  getPane,
  attempts = 20,
  intervalMs = 250,
  sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const interruptedTurnStartedAt = session?.codexTurnStartedAt ?? null
  const tries = Math.max(1, Number(attempts) || 1)
  for (let attempt = 0; attempt < tries; attempt++) {
    const currentStartedAt = session?.codexTurnStartedAt ?? null
    if (interruptedTurnStartedAt !== null && currentStartedAt === null) return 'hook'
    if (currentStartedAt !== interruptedTurnStartedAt) return 'superseded'
    try {
      if (targetStartupState('codex', await getPane()) === 'ready') return 'idle'
    } catch {}
    if (attempt + 1 < tries) await sleepFn(intervalMs)
  }
  return 'timeout'
}

export async function waitForTargetSessionClaim(transition, {
  attempts = 60, intervalMs = 500, sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (transition?.target?.sid) return transition.target.sid
    if (attempt + 1 < attempts) await sleepFn(intervalMs)
  }
  throw new Error(`${providerLabel(transition?.target?.provider)} target hooks did not register`)
}

// Codex can remain hook-silent at an idle resumed TUI until the first prompt
// starts a turn. Pi is the inverse: its native stream cannot accept the prompt
// until SessionStart has claimed the target. Keep this ordering explicit and
// testable because changing it can turn provider switching into a silent wait.
export async function submitTargetValidation(provider, { waitForClaim, inject }) {
  if (provider === 'pi') {
    await waitForClaim()
    return inject()
  }
  await inject()
  return waitForClaim()
}

export function codexPermissionDecision(behavior) {
  const decision = { behavior }
  if (behavior === 'deny') decision.message = 'Denied from Slack.'
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
}

export const CODEX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export const PI_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

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
