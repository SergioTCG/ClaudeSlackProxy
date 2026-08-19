import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const installer = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const codexInstaller = fs.readFileSync(new URL('../install-codex.sh', import.meta.url), 'utf8')
const piInstaller = fs.readFileSync(new URL('../install-pi.sh', import.meta.url), 'utf8')

test('installer accepts provider-selective setup without side effects for help', () => {
  const run = spawnSync('bash', ['install.sh', '--help'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /claude\|codex\|pi\|both\|all/)
})

test('installer preserves installed runtime identities', () => {
  assert.match(installer, /\.claudeslackproxy/)
  assert.match(installer, /\.config\/ccs/)
  assert.match(installer, /si\.sergej\.claudeslackproxy/)
  assert.match(installer, /SergioTCG\/SlackAgentBridge/)
  assert.match(installer, /slack\/app-manifest\.json/)
  assert.match(installer, /Node >= 20 required/)
  assert.match(installer, /bin\/sab-cc/)
  assert.match(installer, /bin\/sab-codex/)
  assert.match(installer, /bin\/sab-pi/)
  assert.match(installer, /bin\/sab-upload/)
})

test('legacy Codex activation remains a no-restart operation', () => {
  assert.match(codexInstaller, /--provider codex --no-daemon-reload/)
  assert.doesNotMatch(codexInstaller, /launchctl/)
})

test('Pi activation remains a no-restart operation', () => {
  assert.match(piInstaller, /--provider pi --no-daemon-reload/)
  assert.doesNotMatch(piInstaller, /launchctl/)
})

test('live daemon reload retries the transient launchd bootstrap race', () => {
  assert.match(installer, /for attempt in 1 2 3; do[\s\S]*launchctl bootstrap/)
  assert.match(installer, /LaunchAgent failed to load after 3 attempts/)
})

test('provider hook installation is idempotent and no-restart is isolated', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-install-'))
  try {
    const fakeBin = path.join(temp, 'fake-bin')
    const config = path.join(temp, 'config')
    const linkedBin = path.join(temp, 'linked-bin')
    const codexHome = path.join(temp, 'codex')
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(config, { recursive: true })
    for (const command of ['claude', 'codex', 'pi', 'tmux']) {
      const executable = path.join(fakeBin, command)
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    fs.writeFileSync(path.join(config, 'env'), [
      'SLACK_BOT_TOKEN=xoxb-test',
      'SLACK_APP_TOKEN=xapp-test',
      'SLACK_TEAM_ID=TTEST',
      '',
    ].join('\n'), { mode: 0o600 })

    const env = {
      ...process.env,
      HOME: temp,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CCS_CONFIG_DIR: config,
      CCS_BIN_DIR: linkedBin,
      CODEX_HOME: codexHome,
      CCS_SKIP_DEPENDENCY_INSTALL: '1',
      CCS_SKIP_GIT_REMOTE_MIGRATION: '1',
    }
    for (let pass = 0; pass < 2; pass++) {
      const run = spawnSync('bash', ['install.sh', '--provider', 'all', '--no-daemon-reload'], {
        encoding: 'utf8', env,
      })
      assert.equal(run.status, 0, run.stderr || run.stdout)
    }

    const claude = JSON.parse(fs.readFileSync(path.join(temp, '.claude/settings.json'), 'utf8'))
    const codex = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'))
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
      assert.equal(claude.hooks[event].length, 1, `duplicate Claude ${event} hook`)
    }
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      assert.equal(codex.hooks[event].length, 1, `duplicate Codex ${event} hook`)
    }
    assert.ok(fs.lstatSync(path.join(linkedBin, 'ccs')).isSymbolicLink())
    assert.ok(fs.lstatSync(path.join(linkedBin, 'ccs-codex')).isSymbolicLink())
    assert.ok(fs.lstatSync(path.join(linkedBin, 'sab-cc')).isSymbolicLink())
    assert.ok(fs.lstatSync(path.join(linkedBin, 'sab-codex')).isSymbolicLink())
    assert.ok(fs.lstatSync(path.join(linkedBin, 'sab-pi')).isSymbolicLink())
    assert.ok(fs.lstatSync(path.join(linkedBin, 'sab-upload')).isSymbolicLink())
    assert.equal(fs.readlinkSync(path.join(linkedBin, 'sab-cc')), path.resolve('bin/sab-cc'))
    assert.equal(fs.readlinkSync(path.join(linkedBin, 'sab-codex')), path.resolve('bin/sab-codex'))
    assert.equal(fs.readlinkSync(path.join(linkedBin, 'sab-pi')), path.resolve('bin/sab-pi'))
    assert.equal(fs.readlinkSync(path.join(linkedBin, 'sab-upload')), path.resolve('bin/sab-upload'))
    assert.equal(fs.existsSync(path.join(temp, '.pi')), false, 'installer must not modify Pi global configuration')
    assert.equal(fs.existsSync(path.join(temp, 'Library/LaunchAgents')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
