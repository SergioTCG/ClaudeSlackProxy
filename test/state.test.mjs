import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('critical state writes are immediate, private, atomic, and cancel stale debounce', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-state-'))
  try {
    const util = new URL('../daemon/util.mjs', import.meta.url).href
    const script = `
      import fs from 'node:fs'
      import path from 'node:path'
      const { saveState, saveStateNow } = await import(${JSON.stringify(util)})
      saveState({ value: 'stale' })
      saveStateNow({ value: 'critical' })
      await new Promise(resolve => setTimeout(resolve, 450))
      const file = path.join(process.env.CCS_CONFIG_DIR, 'state.json')
      process.stdout.write(JSON.stringify({ state: JSON.parse(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 }))
    `
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CCS_CONFIG_DIR: temp }, encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { state: { value: 'critical' }, mode: 0o600 })
    assert.equal(fs.existsSync(path.join(temp, 'state.json.tmp')), false)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
