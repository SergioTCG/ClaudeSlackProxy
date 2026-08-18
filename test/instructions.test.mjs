import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  buildInstructionDocuments, buildInstructionPatch, CODEX_INSTRUCTION_LIMIT,
  deterministicWrapperPatch, fingerprintsMatch, inspectInstructions,
  instructionDocumentsPrompt, instructionProgressText, instructionProposalTimeout, parseInstructionDocuments,
  readInstructionProposal, sanitizedAuxiliaryEnv, validateInstructionDocuments,
  validateInstructionPatch, writeInstructionProposal, validateInstructionResult,
} from '../daemon/instructions.mjs'

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-instructions-'))
  execFileSync('git', ['init', '--quiet', root])
  return root
}

test('instruction preflight recognizes aligned, divergent, and one-file repositories', () => {
  const root = repo()
  try {
    assert.equal(inspectInstructions(root).kind, 'none')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guide\n')
    let preflight = inspectInstructions(root)
    assert.equal(preflight.kind, 'agents_only')
    assert.equal(preflight.safeToPropose, true)
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude only\n')
    assert.equal(inspectInstructions(root).kind, 'divergent')
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Read [AGENTS.md](./AGENTS.md).\n')
    assert.equal(inspectInstructions(root).kind, 'aligned')
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Read AGENTS.md.\n' + 'duplicated detail\n'.repeat(600))
    assert.equal(inspectInstructions(root).kind, 'divergent')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('preflight never imports global memory and offers to compact oversized AGENTS files', () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(CODEX_INSTRUCTION_LIMIT + 1))
    const preflight = inspectInstructions(root)
    assert.equal(preflight.oversize, true)
    assert.equal(preflight.safeToPropose, true)
    const small = repo()
    try {
      fs.writeFileSync(path.join(small, 'CLAUDE.md'), '# local\n')
      const prompt = instructionDocumentsPrompt(inspectInstructions(small))
      assert.match(prompt, /Never import global\/user memory or MEMORY\.md/)
      assert.doesNotMatch(prompt, /unified Git patch/i)
      assert.match(prompt, /<SAB_AGENTS_MD>/)
      assert.match(prompt, /<SAB_CLAUDE_SPECIFIC>/)
    } finally { fs.rmSync(small, { recursive: true, force: true }) }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('document protocol builds a compact canonical guide and deterministic Claude wrapper', () => {
  const parsed = parseInstructionDocuments(`<SAB_AGENTS_MD>
# Canonical guide

Keep the tests green.
</SAB_AGENTS_MD>
<SAB_CLAUDE_SPECIFIC>
Use Claude-specific browser tooling only when explicitly requested.
</SAB_CLAUDE_SPECIFIC>`)
  const documents = buildInstructionDocuments(parsed)
  validateInstructionDocuments(documents)

  assert.match(documents.agents, /^# Canonical guide/)
  assert.match(documents.claude, /Read and follow \[AGENTS\.md\]/)
  assert.match(documents.claude, /Claude-specific instructions/)
  assert.ok(Buffer.byteLength(documents.agents) <= CODEX_INSTRUCTION_LIMIT)
})

test('document protocol rejects malformed, oversized, and duplicative output', () => {
  assert.throws(() => parseInstructionDocuments('not structured'), /document envelope/)
  assert.throws(() => buildInstructionDocuments({
    agents: 'x'.repeat(CODEX_INSTRUCTION_LIMIT + 1), claudeSpecific: '',
  }), /AGENTS\.md exceeds/)
  assert.throws(() => buildInstructionDocuments({
    agents: '# Guide', claudeSpecific: 'Read AGENTS.md and repeat the shared guide.',
  }), /must not repeat or reference AGENTS\.md/)
})

test('bridge generates and applies the Git patch instead of asking the model for diff syntax', async () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Legacy Claude guide\n')
    const preflight = inspectInstructions(root)
    const documents = buildInstructionDocuments({
      agents: '# Canonical guide\n\nRun the full test suite.', claudeSpecific: '',
    })
    const patch = await buildInstructionPatch(preflight, documents)
    const checked = validateInstructionPatch(patch, preflight)

    assert.deepEqual(checked.touched, ['AGENTS.md', 'CLAUDE.md'])
    assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false)
    execFileSync('git', ['-C', root, 'apply', '--whitespace=nowarn', '-'], { input: checked.patch })
    assert.equal(validateInstructionResult(root).kind, 'aligned')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('instruction subprocess timeout is configurable but bounded', () => {
  assert.equal(instructionProposalTimeout({}), 10 * 60 * 1000)
  assert.equal(instructionProposalTimeout({ CCS_INSTRUCTION_TIMEOUT_SECONDS: '30' }), 60 * 1000)
  assert.equal(instructionProposalTimeout({ CCS_INSTRUCTION_TIMEOUT_SECONDS: '99999' }), 30 * 60 * 1000)
  assert.equal(instructionProposalTimeout({ CCS_INSTRUCTION_TIMEOUT_SECONDS: 'invalid' }), 10 * 60 * 1000)
  assert.match(instructionProgressText(125000), /2 min.*source remains active.*no files have changed/i)
})

test('auxiliary model environment excludes bridge and Slack credentials', () => {
  const env = sanitizedAuxiliaryEnv({
    HOME: '/tmp/home', PATH: '/bin', ANTHROPIC_API_KEY: 'keep-for-provider',
    SLACK_BOT_TOKEN: 'remove', SLACK_APP_TOKEN: 'remove', CCS_TMUX: 'remove',
    CODEX_THREAD_ID: 'remove', CODEX_TURN_ID: 'remove', CODEX_SESSION_ID: 'remove',
  })
  assert.deepEqual(env, {
    HOME: '/tmp/home', PATH: '/bin', ANTHROPIC_API_KEY: 'keep-for-provider',
  })
})

test('safe wrapper proposal only creates a thin CLAUDE.md reference', () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Canonical\n')
    const preflight = inspectInstructions(root)
    const patch = deterministicWrapperPatch(preflight)
    const result = validateInstructionPatch(patch, preflight)
    assert.deepEqual(result.touched, ['CLAUDE.md'])
    assert.match(patch, /AGENTS\.md/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('patch validation rejects traversal, unrelated files, binary data, modes, and missing wrapper reference', () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# old\n')
    const preflight = inspectInstructions(root)
    const basic = (file, added = 'Read AGENTS.md') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${added}\n`
    assert.throws(() => validateInstructionPatch(basic('../secret'), preflight), /forbidden path/)
    assert.throws(() => validateInstructionPatch(basic('README.md'), preflight), /forbidden path/)
    assert.throws(() => validateInstructionPatch(basic('CLAUDE.md') + 'GIT binary patch\n', preflight), /binary/)
    assert.throws(() => validateInstructionPatch('old mode 100644\nnew mode 100755\n' + basic('CLAUDE.md'), preflight), /mode/)
    assert.throws(() => validateInstructionPatch(basic('CLAUDE.md', 'Claude only'), preflight), /reference AGENTS/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('fingerprints detect concurrent edits and symlinks are never proposed or patched', () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# one\n')
    const before = inspectInstructions(root)
    assert.equal(fingerprintsMatch(before), true)
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# two\n')
    assert.equal(fingerprintsMatch(before), false)
    fs.unlinkSync(path.join(root, 'AGENTS.md'))
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'AGENTS.md'))
    const linked = inspectInstructions(root)
    assert.equal(linked.safeToPropose, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('instruction proposals are private and integrity checked', () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# canonical\n')
    const patch = deterministicWrapperPatch(inspectInstructions(root))
    const record = writeInstructionProposal(root, 'C1', 'switch-1', patch)
    assert.equal(fs.statSync(record.path).mode & 0o777, 0o600)
    assert.equal(readInstructionProposal(record), patch)
    fs.appendFileSync(record.path, 'tampered')
    assert.throws(() => readInstructionProposal(record), /integrity/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('reconciled output requires compact AGENTS.md and a thin Claude reference', () => {
  const root = repo()
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Canonical\n')
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Read AGENTS.md.\n')
    assert.equal(validateInstructionResult(root).kind, 'aligned')
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(CODEX_INSTRUCTION_LIMIT + 1))
    assert.throws(() => validateInstructionResult(root), /exceeds/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
