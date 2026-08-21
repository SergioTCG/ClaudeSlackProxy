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

// Slash commands are acknowledged before their work runs, so a later failure
// would otherwise look like silence. Prefer a durable channel message; if the
// bot cannot post there, use the command's response_url as an ephemeral final
// fallback. Never let failure reporting crash the Socket Mode daemon.
export async function reportSlashFailure(body, { postChannel, postEphemeral }) {
  const rawCommand = String(body?.command || '')
  const command = /^\/[a-z0-9_-]{1,64}$/.test(rawCommand) ? rawCommand : '/bridge-command'
  const status = command.startsWith('/codex-') ? '/codex-status' : '/cc-status'
  const text = `❌ \`${command}\` failed inside the bridge. Check \`${status}\` before retrying.`
  if (body?.channel_id) {
    try {
      await postChannel(body.channel_id, text)
      return 'channel'
    } catch {}
  }
  try {
    const result = await postEphemeral(body, text)
    return result === false ? 'none' : 'ephemeral'
  } catch {
    return 'none'
  }
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

const SECTION_TEXT_LIMIT = 2900 // Slack caps mrkdwn section text at 3000 chars
const MIN_NATURAL_FILL = 0.55

function safeHardCut(text, limit) {
  let cut = Math.min(limit, text.length)
  // JavaScript slices UTF-16 code units. Never bisect a surrogate pair when an
  // unbroken token leaves us no whitespace boundary to use.
  if (cut < text.length && cut > 0) {
    const before = text.charCodeAt(cut - 1)
    const after = text.charCodeAt(cut)
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) cut--
  }
  return Math.max(1, cut)
}

// Find a useful boundary without cutting inside inline code or a Slack link.
// Prefer paragraph/newline boundaries when they fill most of the section, then
// ordinary whitespace. A hard cut remains the bounded fallback for a single
// token longer than Slack's section limit.
function naturalCut(text, limit, protectInline = true) {
  if (text.length <= limit) return text.length
  if (limit < 1) return 0
  const window = text.slice(0, limit)
  let paragraph = 0, newline = 0, whitespace = 0
  let inCode = false, inLink = false
  for (let i = 0; i < window.length; i++) {
    const char = window[i]
    if (protectInline && char === '`' && !inLink && window[i - 1] !== '\\') {
      inCode = !inCode
      continue
    }
    if (protectInline && !inCode && char === '<') { inLink = true; continue }
    if (protectInline && inLink) {
      if (char === '>') inLink = false
      continue
    }
    if (inCode) continue
    if (/\s/.test(char)) whitespace = i + 1
    if (char === '\n') {
      newline = i + 1
      if (window[i + 1] === '\n' && i + 2 <= limit) paragraph = i + 2
    }
  }

  const floor = Math.floor(limit * MIN_NATURAL_FILL)
  if (paragraph >= floor) return paragraph
  if (newline >= floor) return newline
  if (whitespace >= floor) return whitespace
  return Math.max(paragraph, newline, whitespace) || safeHardCut(text, limit)
}

function splitExact(text, limit, protectInline = true) {
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    const cut = naturalCut(rest, limit, protectInline)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) chunks.push(rest)
  return chunks
}

function fencedSegments(text) {
  const segments = []
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
  let buffer = '', inFence = false
  const push = (type, value) => { if (value) segments.push({ type, text: value }) }

  for (const line of lines) {
    const marker = /^[\t ]*```/.test(line)
    if (!inFence && marker) {
      push('prose', buffer)
      buffer = line
      inFence = true
    } else if (inFence) {
      buffer += line
      if (marker) {
        push('fence', buffer)
        buffer = ''
        inFence = false
      }
    } else {
      buffer += line
    }
  }
  // Preserve malformed/unclosed input verbatim; valid fenced blocks take the
  // specialized path below so every emitted Slack section remains fenced.
  push('prose', buffer)
  return segments
}

function splitLongFence(text, limit) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || []
  const opener = lines.shift() || ''
  const closing = lines.pop() || ''
  const trailing = closing.endsWith('\n') ? '\n' : ''
  const closingMarker = closing.trimEnd()
  const body = lines.join('')
  const bodyLimit = limit - opener.length - closingMarker.length - 1
  if (bodyLimit < 1 || !closingMarker.trimStart().startsWith('```')) return splitExact(text, limit)

  const pieces = splitExact(body, bodyLimit, false)
  return pieces.map((piece, index) =>
    opener + piece + (piece.endsWith('\n') ? '' : '\n') + closingMarker +
      (index === pieces.length - 1 ? trailing : '')
  )
}

function splitMrkdwnSections(text, limit = SECTION_TEXT_LIMIT) {
  const chunks = []
  let current = ''
  const flush = () => {
    if (current) chunks.push(current)
    current = ''
  }
  const appendProse = value => {
    let rest = value
    while (rest) {
      const capacity = limit - current.length
      if (rest.length <= capacity) { current += rest; return }
      // Do not strand a tiny fragment after a preceding Markdown construct.
      if (current && capacity < limit * MIN_NATURAL_FILL) { flush(); continue }
      const cut = naturalCut(rest, capacity)
      if (!cut) { flush(); continue }
      current += rest.slice(0, cut)
      rest = rest.slice(cut)
      flush()
    }
  }

  for (const segment of fencedSegments(text)) {
    if (segment.type === 'fence' && segment.text.length > limit) {
      flush()
      chunks.push(...splitLongFence(segment.text, limit))
    } else if (segment.type === 'fence') {
      if (current && current.length + segment.text.length > limit) flush()
      current += segment.text
    } else {
      appendProse(segment.text)
    }
  }
  flush()
  return chunks
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
    for (const chunk of splitMrkdwnSections(text)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } })
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
