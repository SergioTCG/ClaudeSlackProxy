#!/usr/bin/env node
// Local-only managed Pi canary. It uses a disposable git repository and a mock
// loopback bridge; it never connects to Slack or the live SAB daemon.
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bridgeRoot = path.resolve(here, '..')
const extension = path.join(bridgeRoot, 'pi', 'sab-extension.ts')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-managed-fixture-'))
const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-managed-sessions-'))
const model = process.env.SAB_PI_SMOKE_MODEL || 'qwen38-local/qwen3.8-27b'
const effort = process.env.SAB_PI_SMOKE_EFFORT || 'xhigh'
const adaptive = process.env.SAB_PI_SMOKE_ADAPTIVE === '1'
const privateSentinel = `SAB_PRIVATE_${crypto.randomBytes(12).toString('hex')}`
const sessionId = crypto.randomUUID()
const events = []
let stream = null
let stderr = ''
let started = false
let settled = false
const tmuxName = `sab-managed-smoke-${sessionId.slice(0, 8)}`

function tmuxAlive() {
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'ignore' })
    return true
  } catch { return false }
}

function killTmux() {
  if (!tmuxAlive()) return
  try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }) } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    killTmux()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

function fixtureFile(name, content) {
  fs.writeFileSync(path.join(fixture, name), content, { encoding: 'utf8', mode: 0o600 })
}

fixtureFile('AGENTS.md', `# Managed smoke fixture

Keep changes scoped to the requested calculator function and its test. Run the
test before finishing. Do not commit, push, deploy, or access paths outside this
repository.
`)
fixtureFile('calculator.mjs', `export const identity = value => value
`)
fixtureFile('calculator.test.mjs', `import test from 'node:test'
import assert from 'node:assert/strict'
import { identity } from './calculator.mjs'

test('identity', () => assert.equal(identity(3), 3))
`)
execFileSync('git', ['init', '-q'], { cwd: fixture })
execFileSync('git', ['config', 'user.name', 'SAB Smoke'], { cwd: fixture })
execFileSync('git', ['config', 'user.email', 'sab-smoke@example.invalid'], { cwd: fixture })
execFileSync('git', ['add', 'AGENTS.md', 'calculator.mjs', 'calculator.test.mjs'], { cwd: fixture })
execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: fixture })

function send(payload) {
  if (!stream || stream.destroyed) throw new Error('mock Pi stream is not connected')
  stream.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function maybeStart() {
  const seedSettled = events.some(event => event.event === 'Stop' && !event.managed)
  if (started || !stream || !events.some(event => event.event === 'SessionStart') || !seedSettled) return
  started = true
  setTimeout(() => {
    try {
      const goal = 'Add and export sum(a, b) in calculator.mjs. Add a focused node:test case, run node --test, and leave the repository uncommitted.'
      send(adaptive
        ? { type: 'prompt', text: goal, privateContext: `\n[Private bridge context: ${privateSentinel}]` }
        : {
            type: 'control', action: 'managed-start', requestId: 'smoke-start',
            value: {
              mode: 'auto', goal,
              budgets: { maxMinutes: 20, maxParentTurns: 8, maxSubagents: 4, maxReviewCycles: 1 },
            },
          })
    } catch {
      started = false
    }
  }, 500)
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/pi/stream' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write(': connected\n\n')
    stream = response
    maybeStart()
    request.on('close', () => { if (stream === response) stream = null })
    return
  }
  if (url.pathname === '/pi/trust' && request.method === 'POST') {
    for await (const _chunk of request) {}
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ trusted: 'no', remember: false }))
    return
  }
  if (url.pathname === '/pi/permission' && request.method === 'POST') {
    for await (const _chunk of request) {}
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ behavior: 'deny', reason: 'safe mode is not part of this write canary' }))
    return
  }
  if (url.pathname === '/pi/event' && request.method === 'POST') {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const event = JSON.parse(raw || '{}')
    events.push(event)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true }))
    maybeStart()
    if (event.event === 'Stop' && event.managed?.status === 'complete') settled = true
    if (event.event === 'ManagedStatus' && ['failed', 'cancelled', 'paused'].includes(event.managed?.status)) {
      settled = true
    }
    return
  }
  response.writeHead(404)
  response.end()
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
const endpoint = `http://127.0.0.1:${address.port}`

const args = [
  '--session-dir', sessions, '--session-id', sessionId,
  '--no-extensions', '--extension', extension, '--no-skills', '--no-prompt-templates', '--no-themes',
  '--no-approve', '--model', model, '--thinking', effort,
  'Initialize this disposable smoke session. Reply only READY and use no tools.',
]
// tmux provides the same PTY-backed surface used by production Ghostty. A bare
// stdin pipe does not initialize an idle Pi TUI and cannot exercise
// extension-triggered follow-up turns.
execFileSync('tmux', [
  'new-session', '-d', '-s', tmuxName, '-c', fixture, '--',
  'env', 'CCS_BRIDGE=1', 'CCS_PROVIDER=pi', `CCS_TMUX=${tmuxName}`,
  `CCS_FLAGS=--no-approve --model=${model} --thinking=${effort}`,
  `CCS_ENDPOINT=${endpoint}`, 'pi', ...args,
], { stdio: 'ignore' })

const timeoutAt = Date.now() + 25 * 60_000
while (!settled && Date.now() < timeoutAt) {
  if (!tmuxAlive()) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}

if (tmuxAlive()) {
  try { stderr = execFileSync('tmux', ['capture-pane', '-p', '-S', '-200', '-t', tmuxName], { encoding: 'utf8' }).slice(-12_000) } catch {}
}
killTmux()
server.close()

const terminal = [...events].reverse().find(event => event.managed?.status && ['complete', 'failed', 'cancelled', 'paused'].includes(event.managed.status))
const eventNames = events.map(event => event.event)
const failures = []
if (!settled) failures.push('managed run did not settle before timeout or process exit')
if (terminal?.managed?.status !== 'complete') failures.push(`terminal status was ${terminal?.managed?.status || 'missing'}: ${terminal?.notice || terminal?.managed?.lastError || ''}`)
for (const required of ['SessionStart', 'ManagedPlan', 'AgentStart', 'ManagedCheckpoint', 'ManagedReview', 'Stop']) {
  if (!eventNames.includes(required)) failures.push(`missing event ${required}`)
}
if (adaptive) {
  for (const required of ['ManagedRouting', 'ManagedRoute']) {
    if (!eventNames.includes(required)) failures.push(`missing adaptive event ${required}`)
  }
  const routes = events.filter(event => event.event === 'ManagedRoute').map(event => event.route)
  if (!routes.includes('native')) failures.push('adaptive seed prompt did not take the native route')
  if (!routes.includes('managed')) failures.push(`adaptive coding prompt was not promoted (routes: ${routes.join(', ') || 'none'})`)
  const routingEvents = events.filter(event => ['ManagedRouting', 'ManagedRoute'].includes(event.event))
  if (routingEvents.some(event => JSON.stringify(event).includes(privateSentinel))) {
    failures.push('private context leaked into adaptive routing events')
  }
}
if (events.filter(event => event.event === 'SessionStart').length !== 1) failures.push('child subagent registered with the mock bridge')
if (events.filter(event => event.event === 'Stop' && event.managed?.status === 'complete').length !== 1) {
  failures.push('managed run did not emit exactly one final response')
}
const source = fs.readFileSync(path.join(fixture, 'calculator.mjs'), 'utf8')
const tests = fs.readFileSync(path.join(fixture, 'calculator.test.mjs'), 'utf8')
if (!/export\s+(?:const|function)\s+sum\b/.test(source)) failures.push('sum export was not implemented')
if (!/\bsum\b/.test(tests)) failures.push('sum test was not implemented')
try { execFileSync(process.execPath, ['--test'], { cwd: fixture, stdio: 'pipe' }) }
catch (error) { failures.push(`fixture tests failed: ${String(error.stderr || error.message).slice(0, 2000)}`) }

const report = {
  ok: failures.length === 0,
  adaptive,
  model,
  effort,
  terminalStatus: terminal?.managed?.status || null,
  eventCounts: Object.fromEntries([...new Set(eventNames)].map(name => [name, eventNames.filter(value => value === name).length])),
  managed: terminal?.managed || null,
  failures,
  stderr: failures.length ? stderr : undefined,
  fixture: failures.length ? fixture : undefined,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

if (!failures.length) {
  fs.rmSync(fixture, { recursive: true, force: true })
  fs.rmSync(sessions, { recursive: true, force: true })
} else {
  process.exitCode = 1
}
