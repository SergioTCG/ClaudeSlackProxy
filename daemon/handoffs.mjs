import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const HANDOFF_VERSION = 1
export const MAX_HANDOFF_BYTES = 64 * 1024
export const HANDOFF_SECTIONS = Object.freeze([
  'Current objective',
  'Latest user intent',
  'Decisions and constraints',
  'Repository and working-tree state',
  'Files changed',
  'Commands and tests run',
  'Remaining work',
  'Risks and unresolved questions',
  'Suggested next action',
])

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const safeSegment = value => String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'unknown'

export function handoffPrompt({ sourceProvider, targetProvider, latestUserIntent = '' }) {
  return `Prepare a concise provider handoff from ${sourceProvider} to ${targetProvider}.

Return Markdown only, beginning with "# SAB handoff v1", with exactly these section headings:
${HANDOFF_SECTIONS.map(section => `## ${section}`).join('\n')}

State facts and outcomes, not hidden reasoning. Do not include chain-of-thought, credentials, tokens, environment secrets, full transcripts, or large source-code dumps. Mention uncommitted work and verification honestly. Do not modify files. Do not run commands unless a short read-only status check is essential.
${latestUserIntent ? `\nThe latest Slack intent was:\n${latestUserIntent.slice(0, 2000)}\n` : ''}`
}

export function validateHandoff(content) {
  let text = String(content || '').trim()
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) text = fenced[1].trim()
  if (!text.startsWith('# SAB handoff v1')) throw new Error('handoff is missing the SAB v1 heading')
  const bytes = Buffer.byteLength(text)
  if (!bytes || bytes > MAX_HANDOFF_BYTES) throw new Error(`handoff exceeds ${MAX_HANDOFF_BYTES} bytes`)
  const missing = HANDOFF_SECTIONS.filter(section => !text.includes(`## ${section}`))
  if (missing.length) throw new Error(`handoff is missing sections: ${missing.join(', ')}`)
  return text + '\n'
}

function handoffChannelDir(configDir, channel) {
  return path.join(configDir, 'handoffs', safeSegment(channel))
}

export function deleteHandoffs(configDir, channel) {
  const dir = handoffChannelDir(configDir, channel)
  try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch { return false }
}

export function writeHandoff(configDir, channel, generation, content, { now = Date.now(), keep = 2 } = {}) {
  const text = validateHandoff(content)
  const dir = handoffChannelDir(configDir, channel)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(path.join(configDir, 'handoffs'), 0o700) } catch {}
  try { fs.chmodSync(dir, 0o700) } catch {}
  const name = `${String(generation).padStart(6, '0')}-${now}.md`
  const file = path.join(dir, name)
  const tmp = file + `.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}

  const files = fs.readdirSync(dir).filter(entry => /^\d+-\d+\.md$/.test(entry)).sort().reverse()
  for (const old of files.slice(Math.max(1, keep))) {
    try { fs.unlinkSync(path.join(dir, old)) } catch {}
  }
  return {
    version: HANDOFF_VERSION,
    path: file,
    sha256: digest(text),
    bytes: Buffer.byteLength(text),
    createdAt: now,
  }
}

export function readHandoff(record) {
  if (!record?.path || !record?.sha256) throw new Error('invalid handoff record')
  const text = fs.readFileSync(record.path, 'utf8')
  if (Buffer.byteLength(text) !== record.bytes || digest(text) !== record.sha256) {
    throw new Error('handoff file integrity check failed')
  }
  return text
}

export function targetBootstrapPrompt({ sourceProvider, targetProvider, handoff, handoffPath }) {
  const text = validateHandoff(handoff)
  return `You are taking over an existing Slack Agent Bridge task from ${sourceProvider}.

Read the handoff below and inspect no files yet. Do not edit files, run commands, or begin implementation in this turn. Reply briefly with two labelled lines: "Objective:" and "Next action:". This is a readiness check; the user's queued Slack messages will follow only after the switch commits.

Private handoff record: ${handoffPath}

--- BEGIN HANDOFF ---
${text}--- END HANDOFF ---

Target provider: ${targetProvider}`
}

export function validateBootstrapReply(reply) {
  const text = String(reply || '').trim()
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error('target readiness reply is unexpectedly large')
  if (!/^Objective:/mi.test(text) || !/^Next action:/mi.test(text)) {
    throw new Error('target did not confirm the objective and next action')
  }
  return text
}
