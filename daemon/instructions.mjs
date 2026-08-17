import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CODEX_INSTRUCTION_LIMIT = 32 * 1024
export const MAX_INSTRUCTION_PATCH_BYTES = 96 * 1024
export const CLAUDE_THIN_LIMIT = 8 * 1024
export const MAX_INSTRUCTION_SOURCE_BYTES = 512 * 1024
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

export function instructionProposalPrompt(preflight) {
  if (!preflight?.safeToPropose) throw new Error(preflight?.reason || `instruction state ${preflight?.kind} does not need a proposal`)
  const agents = preflight.agents.content ?? '(missing)'
  const claude = preflight.claude.content ?? '(missing)'
  return `Reconcile the repository's root agent instructions. Output one unified Git patch only; do not edit files or run commands.

Contract:
- AGENTS.md becomes the concise canonical guide shared by humans, Codex, and Claude Code.
- CLAUDE.md becomes a thin wrapper that explicitly tells Claude to read AGENTS.md, plus only genuinely Claude-specific additions.
- Preserve substantive constraints. Remove duplication and contradictions. Never import global/user memory or MEMORY.md.
- Touch only root AGENTS.md and root CLAUDE.md. No rename, binary data, symlink, executable bit, or other mode change.
- Keep AGENTS.md below ${CODEX_INSTRUCTION_LIMIT} bytes.

Current AGENTS.md:
---
${agents}
---

Current CLAUDE.md:
---
${claude}
---`
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
