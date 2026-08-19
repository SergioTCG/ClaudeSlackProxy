import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = path.join(root, 'bin', 'sab-upload')

function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [client, ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('sab-upload refuses to run outside a bridged tmux session', async () => {
  const result = await run(['--grant', 'test', 'report.pdf'], { CCS_BRIDGE: '', CCS_TMUX: '' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /live Slack Agent Bridge session/)
})

test('sab-upload safely sends absolute paths and provider/session binding to the local daemon', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, filenames: ['report final.pdf'] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  for (const provider of ['codex', 'pi']) {
    const result = await run(['--grant=grant-123', '--', 'report final.pdf'], {
      NODE_ENV: 'test',
      CCS_BRIDGE: '1',
      CCS_PROVIDER: provider,
      CCS_TMUX: 'ccs-test',
      CCS_UPLOAD_ENDPOINT: `http://127.0.0.1:${port}/artifact/upload`,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Uploaded report final\.pdf to Slack/)
  }
  assert.deepEqual(requests.map(request => request.headers['x-ccs-provider']), ['codex', 'pi'])
  for (const request of requests) {
    assert.match(request.url, /^\/artifact\/upload\?ppid=\d+&tmux=ccs-test$/)
    assert.equal(request.body.grant, 'grant-123')
    assert.deepEqual(request.body.paths, [path.resolve('report final.pdf')])
  }
})
