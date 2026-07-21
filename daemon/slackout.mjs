// Slack output helpers: per-channel serialized posting (rate-limit safe) and
// markdown → Block Kit conversion with native table blocks.
import { sleep } from './util.mjs'

const chains = new Map()
const lastAt = new Map()

// Serialize all posts per channel with a ≥1.1s gap (Slack: ~1 msg/sec/channel).
export function enqueue(channel, fn) {
  const prev = chains.get(channel) || Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(async () => {
      const wait = 1100 - (Date.now() - (lastAt.get(channel) || 0))
      if (wait > 0) await sleep(wait)
      try {
        return await fn()
      } finally {
        lastAt.set(channel, Date.now())
      }
    })
  chains.set(channel, next)
  return next
}

export const escapeText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function unescapeSlack(s) {
  return String(s)
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// Convert a markdown subset to Slack mrkdwn — but never inside ``` fenced code,
// so pasted code with '#' comments or '**' survives the trip to Slack.
function mrkdwn(text) {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
            .replace(/\*\*(.+?)\*\*/g, '*$1*')
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>')
    )
    .join('')
}

function parseTable(lines) {
  const rows = lines.map(l =>
    l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim().replace(/\*\*/g, ''))
  )
  rows.splice(1, 1) // separator row
  const width = Math.min(Math.max(...rows.map(r => r.length)), 20)
  return {
    type: 'table',
    rows: rows.slice(0, 100).map(r => {
      const cells = r.slice(0, width)
      while (cells.length < width) cells.push('')
      return cells.map(c => ({ type: 'raw_text', text: c.slice(0, 400) || ' ' }))
    }),
  }
}

// Returns an array of message payloads [{text, blocks}] ready for chat.postMessage.
export function mdToMessages(md) {
  const lines = md.split('\n')
  const blocks = []
  let buf = []
  const flushText = () => {
    const text = mrkdwn(buf.join('\n')).trim()
    buf = []
    if (!text) return
    // section blocks cap at 3000 chars
    for (let i = 0; i < text.length; i += 2900) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + 2900) } })
    }
  }
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; buf.push(lines[i]); continue }
    if (inFence) { buf.push(lines[i]); continue } // never parse tables inside code
    const isRow = /^\s*\|.+\|\s*$/.test(lines[i])
    const isSep = /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')
    if (isRow && isSep) {
      let j = i
      while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) j++
      flushText()
      try {
        blocks.push(parseTable(lines.slice(i, j)))
      } catch {
        buf.push(...lines.slice(i, j)) // fall back to raw text
      }
      i = j - 1
    } else {
      buf.push(lines[i])
    }
  }
  flushText()

  const messages = []
  for (let i = 0; i < blocks.length; i += 40) {
    const slice = blocks.slice(i, i + 40)
    const fallback = slice.find(b => b.type === 'section')?.text?.text?.slice(0, 200) || 'response'
    messages.push({ text: fallback, blocks: slice })
  }
  return messages
}
