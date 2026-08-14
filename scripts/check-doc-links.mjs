#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ignored = new Set(['.git', 'node_modules'])

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : []
  })
}

const failures = []
let checked = 0
for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8')
  const targets = [
    ...[...text.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]),
    ...[...text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map(match => match[1]),
  ]
  for (let target of targets) {
    target = target.replace(/^<|>$/g, '').split('#')[0].split('?')[0]
    if (!target || /^(?:[a-z]+:|\/\/)/i.test(target)) continue
    checked++
    let decoded = target
    try { decoded = decodeURIComponent(target) } catch {}
    const resolved = path.resolve(path.dirname(file), decoded)
    if (!fs.existsSync(resolved)) failures.push(`${path.relative(root, file)} -> ${target}`)
  }
}

if (failures.length) {
  console.error(`Broken local Markdown links:\n${failures.map(item => `  ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`Checked ${checked} local Markdown links.`)
