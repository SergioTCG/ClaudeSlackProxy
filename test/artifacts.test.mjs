import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ARTIFACT_GRANT_TTL_MS, artifactDeliveryInstruction, createArtifactGrantStore,
  fulfillArtifactUpload, resolveArtifactFiles, slackArtifactUploadOptions,
} from '../daemon/artifacts.mjs'

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-artifacts-'))
  const workspace = path.join(temp, 'workspace')
  const outside = path.join(temp, 'outside')
  fs.mkdirSync(workspace)
  fs.mkdirSync(outside)
  return { temp, workspace, outside }
}

function grantFields(workspace, overrides = {}) {
  return {
    sessionId: 'session-1', channelId: 'C123', provider: 'codex',
    userId: 'U123', messageTs: '1234.5678', threadTs: '1234.5678', workspaceRoot: workspace,
    ...overrides,
  }
}

test('artifact grants are session-bound, single-use, and never reveal their token in errors', async () => {
  const { temp, workspace } = fixture()
  try {
    fs.writeFileSync(path.join(workspace, 'report.pdf'), 'pdf bytes')
    let now = 10_000
    const store = createArtifactGrantStore({ now: () => now, token: () => 'secret-grant' })
    const issued = store.issue(grantFields(workspace))
    assert.equal(issued.token, 'secret-grant')
    assert.equal(issued.expiresAt, now + ARTIFACT_GRANT_TTL_MS)

    await assert.rejects(
      fulfillArtifactUpload(store, {
        token: issued.token,
        binding: { sessionId: 'another-session', channelId: 'C123', provider: 'codex' },
        paths: [path.join(workspace, 'report.pdf')],
      }, async () => {}),
      error => error.code === 'invalid_grant' && !error.message.includes(issued.token),
    )

    let uploaded
    const result = await fulfillArtifactUpload(store, {
      token: issued.token,
      binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
      paths: [path.join(workspace, 'report.pdf')],
    }, async request => { uploaded = request })
    assert.deepEqual(result.filenames, ['report.pdf'])
    assert.equal(uploaded.grant.userId, 'U123')
    assert.equal(uploaded.grant.messageTs, '1234.5678')
    assert.equal(uploaded.grant.threadTs, '1234.5678')

    await assert.rejects(
      fulfillArtifactUpload(store, {
        token: issued.token,
        binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
        paths: [path.join(workspace, 'report.pdf')],
      }, async () => {}),
      error => error.code === 'invalid_grant',
    )
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('expired grants are rejected and pruned', async () => {
  const { temp, workspace } = fixture()
  try {
    fs.writeFileSync(path.join(workspace, 'result.txt'), 'done')
    let now = 1_000
    const store = createArtifactGrantStore({ now: () => now, token: () => 'expires' })
    store.issue(grantFields(workspace))
    now += ARTIFACT_GRANT_TTL_MS + 1
    await assert.rejects(
      fulfillArtifactUpload(store, {
        token: 'expires',
        binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
        paths: [path.join(workspace, 'result.txt')],
      }, async () => {}),
      error => error.code === 'invalid_grant',
    )
    assert.equal(store.size(), 0)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('failed uploads release the grant for a bounded retry', async () => {
  const { temp, workspace } = fixture()
  try {
    const report = path.join(workspace, 'report.pdf')
    fs.writeFileSync(report, 'pdf bytes')
    const store = createArtifactGrantStore({ token: () => 'retryable' })
    store.issue(grantFields(workspace))
    await assert.rejects(
      fulfillArtifactUpload(store, {
        token: 'retryable',
        binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
        paths: [report],
      }, async () => { throw new Error('Slack unavailable') }),
      /Slack unavailable/,
    )
    const result = await fulfillArtifactUpload(store, {
      token: 'retryable',
      binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
      paths: [report],
    }, async () => {})
    assert.deepEqual(result.filenames, ['report.pdf'])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('provider handoff revokes old session grants without affecting the target', () => {
  const { temp, workspace } = fixture()
  try {
    let n = 0
    const store = createArtifactGrantStore({ token: () => `grant-${++n}` })
    const old = store.issue({ sessionId: 'old', channelId: 'C1', provider: 'claude', userId: 'U1', workspaceRoot: workspace })
    const target = store.issue({ sessionId: 'new', channelId: 'C1', provider: 'codex', userId: 'U1', workspaceRoot: workspace })
    assert.equal(store.revoke({ sessionId: 'old', channelId: 'C1' }), 1)
    assert.throws(() => store.claim(old.token, { sessionId: 'old', channelId: 'C1', provider: 'claude' }), /invalid/)
    assert.equal(store.claim(target.token, { sessionId: 'new', channelId: 'C1', provider: 'codex' }).sessionId, 'new')
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('an in-flight grant cannot be used concurrently', async () => {
  const { temp, workspace } = fixture()
  try {
    const report = path.join(workspace, 'report.pdf')
    fs.writeFileSync(report, 'pdf bytes')
    const store = createArtifactGrantStore({ token: () => 'in-flight' })
    store.issue(grantFields(workspace))
    let unblock
    const blocked = new Promise(resolve => { unblock = resolve })
    const first = fulfillArtifactUpload(store, {
      token: 'in-flight',
      binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
      paths: [report],
    }, () => blocked)
    await assert.rejects(
      fulfillArtifactUpload(store, {
        token: 'in-flight',
        binding: { sessionId: 'session-1', channelId: 'C123', provider: 'codex' },
        paths: [report],
      }, async () => {}),
      error => error.code === 'grant_in_use',
    )
    unblock()
    await first
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('artifact paths must be regular files contained by their real workspace path', () => {
  const { temp, workspace, outside } = fixture()
  try {
    const inside = path.join(workspace, 'inside.txt')
    const secret = path.join(outside, 'secret.txt')
    fs.writeFileSync(inside, 'inside')
    fs.writeFileSync(secret, 'outside')
    fs.symlinkSync(secret, path.join(workspace, 'escape.txt'))

    assert.deepEqual(resolveArtifactFiles(workspace, [inside]).map(f => f.filename), ['inside.txt'])
    assert.throws(() => resolveArtifactFiles(workspace, [secret]), error => error.code === 'path_outside_workspace')
    assert.throws(() => resolveArtifactFiles(workspace, [path.join(workspace, 'escape.txt')]), error => error.code === 'path_outside_workspace')
    assert.throws(() => resolveArtifactFiles(workspace, [workspace]), error => error.code === 'not_a_regular_file')
    assert.throws(() => resolveArtifactFiles(workspace, [path.join(workspace, 'missing')]), error => error.code === 'file_not_found')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('artifact validation enforces file-count and aggregate-size limits', () => {
  const { temp, workspace } = fixture()
  try {
    const paths = []
    for (let i = 0; i < 3; i++) {
      const file = path.join(workspace, `${i}.bin`)
      fs.writeFileSync(file, Buffer.alloc(4))
      paths.push(file)
    }
    assert.throws(() => resolveArtifactFiles(workspace, paths, { maxFiles: 2 }), error => error.code === 'too_many_files')
    assert.throws(() => resolveArtifactFiles(workspace, paths, { maxTotalBytes: 10 }), error => error.code === 'files_too_large')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('delivery instruction is explicit, provider-neutral, and keeps the destination daemon-controlled', () => {
  const instruction = artifactDeliveryInstruction('grant-123')
  assert.match(instruction, /if and only if/i)
  assert.match(instruction, /sab-upload --grant grant-123 -- FILE_PATH/)
  assert.match(instruction, /current workspace/i)
  assert.doesNotMatch(instruction, /channel[_ -]?id/i)
})

test('Slack upload options derive their immutable destination and thread from the grant', () => {
  const one = slackArtifactUploadOptions({ channelId: 'C123', userId: 'U123', threadTs: '100.1' }, [
    { path: '/workspace/report.pdf', filename: 'report.pdf', size: 10 },
  ])
  assert.equal(one.channel_id, 'C123')
  assert.equal(one.thread_ts, '100.1')
  assert.equal(one.file, '/workspace/report.pdf')
  assert.equal(one.filename, 'report.pdf')
  assert.match(one.initial_comment, /<@U123>/)

  const many = slackArtifactUploadOptions({ channelId: 'C456', userId: 'U456' }, [
    { path: '/workspace/a.png', filename: 'a.png', size: 10 },
    { path: '/workspace/b.png', filename: 'b.png', size: 10 },
  ])
  assert.equal(many.channel_id, 'C456')
  assert.equal('thread_ts' in many, false)
  assert.equal('file' in many, false)
  assert.deepEqual(many.file_uploads.map(file => file.filename), ['a.png', 'b.png'])
})
