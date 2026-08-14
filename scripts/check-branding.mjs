#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json'))
const manifest = JSON.parse(read('slack/app-manifest.json'))
const readme = read('README.md')
const installer = read('install.sh')
const failures = []
const requireCheck = (condition, message) => { if (!condition) failures.push(message) }

requireCheck(pkg.name === 'slack-agent-bridge', 'package name is not provider-neutral')
requireCheck(/^1\.\d+\.\d+(?:-rc\.\d+)?$/.test(pkg.version), 'package version is not a 1.x release')
requireCheck(pkg.repository.url.endsWith('/SlackAgentBridge.git'), 'package repository URL is stale')
requireCheck(pkg.engines.node === '>=20', 'package Node minimum does not match Slack SDK requirements')
requireCheck(readme.startsWith('# Slack Agent Bridge\n'), 'README title is stale')
requireCheck(manifest.display_information.name === 'Slack Agent Bridge', 'Slack app display name is stale')
requireCheck(manifest.features.bot_user.display_name === 'Clavdivs', 'bot personality changed unexpectedly')
requireCheck(installer.includes('SergioTCG/SlackAgentBridge.git'), 'installer clone URL is stale')
requireCheck(installer.includes('.claudeslackproxy'), 'installer lost legacy checkout detection')
requireCheck(installer.includes('si.sergej.claudeslackproxy'), 'installer lost the compatible LaunchAgent label')
requireCheck(readme.includes('`sab-cc`') && readme.includes('`sab-codex`'), 'README does not document canonical launchers')
requireCheck(readme.includes('`ccs`') && readme.includes('`ccs-codex`'), 'README lost compatibility aliases')
requireCheck(!fs.existsSync(path.join(root, 'spike/slack-app-manifest.yaml')), 'stale YAML manifest still exists')

for (const command of manifest.features.slash_commands.map(item => item.command)) {
  requireCheck(readme.includes(`\`${command}`), `README does not document ${command}`)
}
for (const file of ['AGENTS.md', 'CLAUDE.md', 'docs/migrating-to-1.0.md', 'docs/migrating-to-1.1.md', 'docs/release-checklist.md']) {
  requireCheck(fs.existsSync(path.join(root, file)), `missing ${file}`)
}

if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('Branding and compatibility contract checks passed.')
