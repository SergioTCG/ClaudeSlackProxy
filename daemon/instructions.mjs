import crypto from 'node:crypto'
import { execFile as _execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(_execFile)

export const CODEX_INSTRUCTION_LIMIT = 32 * 1024
export const MAX_INSTRUCTION_PATCH_BYTES = 96 * 1024
export const CLAUDE_THIN_LIMIT = 8 * 1024
export const MAX_INSTRUCTION_SOURCE_BYTES = 512 * 1024
export const DEFAULT_INSTRUCTION_TIMEOUT_MS = 10 * 60 * 1000
export const MIN_INSTRUCTION_TIMEOUT_MS = 60 * 1000
export const MAX_INSTRUCTION_TIMEOUT_MS = 30 * 60 * 1000
export const CLAUDE_WRAPPER = `# Claude Code instructions

Read and follow [AGENTS.md](./AGENTS.md) as the canonical repository guide.
Claude-specific constraints, if any, belong below this line and must not copy or contradict AGENTS.md.
`

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

function repoRoot(cwd) {
  let cursor = path.resolve(cwd)
  for (;;) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

function readInstruction(root, name) {
  const file = path.join(root, name)
  try {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) return { name, path: file, exists: true, symlink: true, bytes: stat.size, sha256: null, content: null }
    if (!stat.isFile()) return { name, path: file, exists: true, unsupported: true, bytes: stat.size, sha256: null, content: null }
    const content = fs.readFileSync(file, 'utf8')
    return { name, path: file, exists: true, symlink: false, bytes: Buffer.byteLength(content), sha256: sha256(content), content }
  } catch (error) {
    if (error?.code === 'ENOENT') return { name, path: file, exists: false, symlink: false, bytes: 0, sha256: null, content: null }
    throw error
  }
}

export function inspectInstructions(cwd) {
  const root = repoRoot(cwd)
  if (!root) return { kind: 'non_git', root: null, safeToPropose: false, reason: 'automatic instruction alignment requires a Git worktree' }
  const agents = readInstruction(root, 'AGENTS.md')
  const claude = readInstruction(root, 'CLAUDE.md')
  const invalid = [agents, claude].find(file => file.symlink || file.unsupported)
  const rootBytes = agents.bytes + claude.bytes
  let kind = 'none'
  if (agents.exists && claude.exists) {
    kind = /\bAGENTS\.md\b/i.test(claude.content || '') && claude.bytes <= CLAUDE_THIN_LIMIT ? 'aligned' : 'divergent'
  }
  else if (agents.exists) kind = 'agents_only'
  else if (claude.exists) kind = 'claude_only'
  const oversize = agents.bytes > CODEX_INSTRUCTION_LIMIT
  const sourceTooLarge = agents.bytes > MAX_INSTRUCTION_SOURCE_BYTES || claude.bytes > MAX_INSTRUCTION_SOURCE_BYTES
  const reason = invalid
    ? `${invalid.name} is not a regular file`
    : sourceTooLarge
      ? `an instruction source exceeds the ${MAX_INSTRUCTION_SOURCE_BYTES}-byte proposal limit`
      : null
  return {
    kind, root, agents, claude, rootBytes, oversize,
    safeToPropose: !invalid && !sourceTooLarge && !['non_git', 'none', 'aligned'].includes(kind),
    reason,
    fingerprints: {
      'AGENTS.md': { exists: agents.exists, bytes: agents.bytes, sha256: agents.sha256, symlink: agents.symlink || false },
      'CLAUDE.md': { exists: claude.exists, bytes: claude.bytes, sha256: claude.sha256, symlink: claude.symlink || false },
    },
  }
}

export function fingerprintsMatch(preflight) {
  if (!preflight?.root || !preflight?.fingerprints) return false
  const current = inspectInstructions(preflight.root)
  return ['AGENTS.md', 'CLAUDE.md'].every(name => {
    const before = preflight.fingerprints[name]
    const after = current.fingerprints[name]
    return before.exists === after.exists && before.bytes === after.bytes && before.sha256 === after.sha256 && before.symlink === after.symlink
  })
}

export function instructionDocumentsPrompt(preflight) {
  if (!preflight?.safeToPropose) throw new Error(preflight?.reason || `instruction state ${preflight?.kind} does not need a proposal`)
  const agents = preflight.agents.content ?? '(missing)'
  const claude = preflight.claude.content ?? '(missing)'
  return `Reconcile the repository's root agent instructions. Do not edit files, run commands, or output a Git patch.

Contract:
- AGENTS.md becomes the concise canonical guide shared by humans, Codex, and Claude Code.
- Return the complete AGENTS.md plus only genuinely Claude-specific additions; the bridge constructs the thin CLAUDE.md wrapper and Git patch deterministically.
- Preserve substantive constraints. Remove duplication and contradictions. Never import global/user memory or MEMORY.md.
- Keep AGENTS.md below ${CODEX_INSTRUCTION_LIMIT} bytes.
- Do not repeat shared AGENTS.md guidance in the Claude-specific section. Use (none) when no provider-specific additions are needed.

Output exactly this envelope, with no code fences or commentary:
<SAB_AGENTS_MD>
complete canonical AGENTS.md
</SAB_AGENTS_MD>
<SAB_CLAUDE_SPECIFIC>
Claude-only additions, or (none)
</SAB_CLAUDE_SPECIFIC>

Current AGENTS.md:
---
${agents}
---

Current CLAUDE.md:
---
${claude}
---`
}

// Backward-compatible internal name for callers outside the daemon. The
// protocol now returns documents, never model-authored diff syntax.
export const instructionProposalPrompt = instructionDocumentsPrompt

const normalizeDocument = value => String(value || '').replace(/\r\n?/g, '\n').trim() + '\n'

export function parseInstructionDocuments(output) {
  const text = String(output || '').trim()
  const match = /^<SAB_AGENTS_MD>\s*\n([\s\S]*?)\n<\/SAB_AGENTS_MD>\s*\n<SAB_CLAUDE_SPECIFIC>\s*\n([\s\S]*?)\n<\/SAB_CLAUDE_SPECIFIC>$/.exec(text)
  if (!match) throw new Error('instruction response does not match the required document envelope')
  const claudeSpecific = /^\s*\(none\)\s*$/i.test(match[2]) ? '' : match[2]
  return { agents: normalizeDocument(match[1]), claudeSpecific: claudeSpecific ? normalizeDocument(claudeSpecific) : '' }
}

export function validateInstructionDocuments(documents) {
  const agents = String(documents?.agents || '')
  const claude = String(documents?.claude || '')
  if (!agents.trim()) throw new Error('generated AGENTS.md is empty')
  if (Buffer.byteLength(agents) > CODEX_INSTRUCTION_LIMIT) {
    throw new Error(`generated AGENTS.md exceeds ${CODEX_INSTRUCTION_LIMIT} bytes`)
  }
  if (!claude.startsWith(CLAUDE_WRAPPER.trimEnd())) throw new Error('generated CLAUDE.md is not the required deterministic wrapper')
  if (!/\bAGENTS\.md\b/i.test(claude)) throw new Error('generated CLAUDE.md must reference AGENTS.md')
  if (Buffer.byteLength(claude) > CLAUDE_THIN_LIMIT) throw new Error(`generated CLAUDE.md exceeds ${CLAUDE_THIN_LIMIT} bytes`)
  if (/\0|<\/?SAB_(?:AGENTS_MD|CLAUDE_SPECIFIC)>/.test(agents + claude)) {
    throw new Error('generated instruction documents contain forbidden control markers')
  }
  return documents
}

export function buildInstructionDocuments({ agents, claudeSpecific = '' } = {}) {
  const canonical = normalizeDocument(agents)
  const specific = String(claudeSpecific || '').replace(/\r\n?/g, '\n').trim()
  if (/\bAGENTS\.md\b/i.test(specific)) throw new Error('Claude-specific additions must not repeat or reference AGENTS.md')
  const suffix = specific ? `\n\n## Claude-specific instructions\n\n${specific}` : ''
  const documents = {
    agents: canonical,
    claude: normalizeDocument(CLAUDE_WRAPPER.trimEnd() + suffix),
  }
  return validateInstructionDocuments(documents)
}

export function instructionProposalTimeout(env = process.env) {
  const seconds = Number(env.CCS_INSTRUCTION_TIMEOUT_SECONDS)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_INSTRUCTION_TIMEOUT_MS
  return Math.min(MAX_INSTRUCTION_TIMEOUT_MS, Math.max(MIN_INSTRUCTION_TIMEOUT_MS, Math.round(seconds * 1000)))
}

export function instructionProgressText(elapsedMs) {
  const minutes = Math.max(1, Math.floor(Number(elapsedMs || 0) / 60000))
  return `⏳ Read-only instruction consolidation is still running (${minutes} min). The source remains active; no files have changed.`
}

export function sanitizedAuxiliaryEnv(input = process.env) {
  const env = { ...input }
  for (const key of Object.keys(env)) if (/^(?:CCS_|SLACK_)/.test(key)) delete env[key]
  for (const key of ['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SESSION_ID']) delete env[key]
  return env
}

export async function buildInstructionPatch(preflight, documents, { tempRoot = os.tmpdir() } = {}) {
  if (!preflight?.root) throw new Error('instruction patch requires a repository preflight')
  validateInstructionDocuments(documents)
  const temp = fs.mkdtempSync(path.join(tempRoot, 'sab-instruction-patch-'))
  try {
    fs.chmodSync(temp, 0o700)
    await execFile('git', ['init', '--quiet', temp])
    for (const file of [preflight.agents, preflight.claude]) {
      if (file?.exists && file.content != null) fs.writeFileSync(path.join(temp, file.name), file.content, { mode: 0o600 })
    }
    await execFile('git', ['-C', temp, '-c', 'core.autocrlf=false', 'add', '-A'])
    await execFile('git', ['-C', temp, '-c', 'user.name=Slack Agent Bridge', '-c', 'user.email=bridge@localhost',
      '-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'instruction baseline'])
    fs.writeFileSync(path.join(temp, 'AGENTS.md'), documents.agents, { mode: 0o600 })
    fs.writeFileSync(path.join(temp, 'CLAUDE.md'), documents.claude, { mode: 0o600 })
    await execFile('git', ['-C', temp, '-c', 'core.autocrlf=false', 'add', '-A', '--', 'AGENTS.md', 'CLAUDE.md'])
    const { stdout } = await execFile('git', ['-C', temp, '-c', 'core.autocrlf=false', 'diff', '--cached', '--binary', '--', 'AGENTS.md', 'CLAUDE.md'], {
      maxBuffer: MAX_INSTRUCTION_PATCH_BYTES * 2,
    })
    if (!stdout.trim()) throw new Error('deterministic instruction patch is empty')
    return stdout.trimEnd() + '\n'
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function normalizedDiffPath(raw) {
  const value = String(raw || '').trim().split(/\s+/)[0]
  if (value === '/dev/null') return value
  return value.replace(/^[ab]\//, '')
}

export function validateInstructionPatch(patch, preflight) {
  const text = String(patch || '').trim() + '\n'
  const bytes = Buffer.byteLength(text)
  if (bytes <= 1 || bytes > MAX_INSTRUCTION_PATCH_BYTES) throw new Error('instruction patch is empty or too large')
  if (text.includes('\0') || /GIT binary patch|Binary files .* differ/i.test(text)) throw new Error('binary instruction patches are forbidden')
  if (/^(?:old|deleted file) mode |^similarity index |^(?:rename|copy) (?:from|to) /m.test(text) ||
      /^new file mode (?!100644$)/m.test(text)) {
    throw new Error('instruction patch may not rename files or change file modes')
  }
  const touched = new Set()
  for (const match of text.matchAll(/^diff --git\s+(\S+)\s+(\S+)\s*$/gm)) {
    touched.add(normalizedDiffPath(match[1])); touched.add(normalizedDiffPath(match[2]))
  }
  for (const match of text.matchAll(/^(?:---|\+\+\+)\s+(\S+).*$/gm)) {
    const file = normalizedDiffPath(match[1])
    if (file !== '/dev/null') touched.add(file)
  }
  if (!touched.size) throw new Error('instruction patch has no file headers')
  for (const file of touched) {
    if (!['AGENTS.md', 'CLAUDE.md'].includes(file) || file.includes('/') || file.includes('..')) {
      throw new Error(`instruction patch touches forbidden path: ${file}`)
    }
  }
  if (!touched.has('CLAUDE.md') || !/^\+.*AGENTS\.md/im.test(text)) {
    throw new Error('CLAUDE.md must explicitly reference AGENTS.md')
  }
  if (!touched.has('AGENTS.md') && (preflight?.kind !== 'agents_only' || preflight?.oversize)) {
    throw new Error('reconciliation must produce canonical AGENTS.md')
  }
  if (preflight?.root) {
    for (const name of touched) {
      try {
        if (fs.lstatSync(path.join(preflight.root, name)).isSymbolicLink()) throw new Error(`${name} is a symlink`)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return { patch: text, bytes, touched: [...touched].sort(), sha256: sha256(text) }
}

export function deterministicWrapperPatch(preflight) {
  if (preflight?.kind !== 'agents_only') throw new Error('deterministic wrapper applies only when CLAUDE.md is absent')
  const lines = CLAUDE_WRAPPER.trimEnd().split('\n').map(line => `+${line}`).join('\n')
  return `diff --git a/CLAUDE.md b/CLAUDE.md
new file mode 100644
--- /dev/null
+++ b/CLAUDE.md
@@ -0,0 +1,${CLAUDE_WRAPPER.trimEnd().split('\n').length} @@
${lines}
`
}

export function writeInstructionProposal(configDir, channel, transitionId, patch) {
  const dir = path.join(configDir, 'handoffs', String(channel).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  const file = path.join(dir, `proposal-${String(transitionId).replace(/[^A-Za-z0-9_-]/g, '_')}.patch`)
  const tmp = file + `.tmp-${process.pid}`
  fs.writeFileSync(tmp, String(patch), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
  return { path: file, bytes: Buffer.byteLength(patch), sha256: sha256(patch) }
}

export function readInstructionProposal(record) {
  if (!record?.path || !record?.sha256) throw new Error('invalid instruction proposal record')
  const patch = fs.readFileSync(record.path, 'utf8')
  if (Buffer.byteLength(patch) !== record.bytes || sha256(patch) !== record.sha256) {
    throw new Error('instruction proposal integrity check failed')
  }
  return patch
}

export function validateInstructionResult(root) {
  const inspected = inspectInstructions(root)
  if (!inspected.agents?.exists || inspected.agents.symlink || inspected.agents.unsupported || !inspected.agents.content?.trim()) {
    throw new Error('reconciliation must leave a non-empty regular AGENTS.md')
  }
  if (inspected.agents.bytes > CODEX_INSTRUCTION_LIMIT) {
    throw new Error(`reconciled AGENTS.md exceeds ${CODEX_INSTRUCTION_LIMIT} bytes`)
  }
  if (!inspected.claude?.exists || inspected.claude.symlink || inspected.claude.unsupported ||
      !/\bAGENTS\.md\b/i.test(inspected.claude.content || '')) {
    throw new Error('reconciliation must leave a regular CLAUDE.md that references AGENTS.md')
  }
  return inspected
}
