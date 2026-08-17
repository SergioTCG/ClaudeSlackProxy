import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  HANDOFF_SECTIONS, MAX_HANDOFF_BYTES, deleteHandoffs, handoffPrompt, readHandoff, targetBootstrapPrompt,
  validateBootstrapReply, validateHandoff, writeHandoff,
} from '../daemon/handoffs.mjs'

const valid = suffix => '# SAB handoff v1\n' + HANDOFF_SECTIONS.map(section => `## ${section}\n${section} ${suffix}`).join('\n')

test('handoff prompt forbids secrets, hidden reasoning, transcript dumps, and edits', () => {
  const prompt = handoffPrompt({ sourceProvider: 'claude', targetProvider: 'codex', latestUserIntent: 'switch now' })
  assert.match(prompt, /chain-of-thought/)
  assert.match(prompt, /credentials, tokens/)
  assert.match(prompt, /full transcripts/)
  assert.match(prompt, /Do not modify files/)
  for (const section of HANDOFF_SECTIONS) assert.match(prompt, new RegExp(`## ${section}`))
})

test('handoff validation enforces the schema and byte cap', () => {
  assert.match(validateHandoff(valid('ok')), /^# SAB handoff v1/)
  assert.match(validateHandoff(`\`\`\`markdown\n${valid('fenced')}\n\`\`\``), /fenced/)
  assert.throws(() => validateHandoff('# SAB handoff v1\n'), /missing sections/)
  assert.throws(() => validateHandoff(valid('x') + 'x'.repeat(MAX_HANDOFF_BYTES)), /exceeds/)
})

test('handoffs are private, integrity checked, and retain only two generations', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-handoff-'))
  try {
    const one = writeHandoff(temp, 'C/unsafe', 1, valid('one'), { now: 1 })
    writeHandoff(temp, 'C/unsafe', 2, valid('two'), { now: 2 })
    const three = writeHandoff(temp, 'C/unsafe', 3, valid('three'), { now: 3 })
    assert.equal(fs.statSync(three.path).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(three.path)).mode & 0o777, 0o700)
    assert.equal(fs.readdirSync(path.dirname(three.path)).filter(f => f.endsWith('.md')).length, 2)
    assert.equal(fs.existsSync(one.path), false)
    assert.match(readHandoff(three), /three/)
    fs.appendFileSync(three.path, 'tampered')
    assert.throws(() => readHandoff(three), /integrity/)
    assert.equal(deleteHandoffs(temp, 'C/unsafe'), true)
    assert.equal(fs.existsSync(path.dirname(three.path)), false)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('target bootstrap is read-only and requires a structured readiness reply', () => {
  const prompt = targetBootstrapPrompt({
    sourceProvider: 'codex', targetProvider: 'claude', handoff: valid('ready'), handoffPath: '/private/handoff.md',
  })
  assert.match(prompt, /Do not edit files, run commands/)
  assert.match(prompt, /Objective:/)
  assert.equal(validateBootstrapReply('Objective: finish tests\nNext action: inspect status'), 'Objective: finish tests\nNext action: inspect status')
  assert.throws(() => validateBootstrapReply('looks good'), /did not confirm/)
})
