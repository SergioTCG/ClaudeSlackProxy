import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ARTIFACT_GRANT_TTL_MS = 2 * 60 * 60 * 1000
export const MAX_ARTIFACT_FILES = 10
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

export class ArtifactUploadError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ArtifactUploadError'
    this.code = code
    this.status = status
  }
}

function canonicalDirectory(directory) {
  try {
    const real = fs.realpathSync(directory)
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory')
    return real
  } catch {
    throw new ArtifactUploadError('invalid_workspace', 'The authorized workspace is no longer available.')
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function safeFilename(file) {
  return path.basename(file).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\]+/g, '_')
    .slice(0, 255) || 'artifact'
}

export function resolveArtifactFiles(workspaceRoot, requestedPaths, {
  maxFiles = MAX_ARTIFACT_FILES,
  maxTotalBytes = MAX_ARTIFACT_BYTES,
} = {}) {
  const root = canonicalDirectory(workspaceRoot)
  if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) {
    throw new ArtifactUploadError('no_files', 'Provide at least one file to upload.')
  }
  if (requestedPaths.length > maxFiles) {
    throw new ArtifactUploadError('too_many_files', `At most ${maxFiles} files can be uploaded at once.`)
  }

  const files = []
  const seen = new Set()
  let totalBytes = 0
  for (const requested of requestedPaths) {
    if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) {
      throw new ArtifactUploadError('invalid_path', 'Every artifact path must be a non-empty string.')
    }
    const candidate = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(root, requested)
    let real
    try { real = fs.realpathSync(candidate) }
    catch { throw new ArtifactUploadError('file_not_found', 'An artifact file does not exist.') }
    if (!isWithin(root, real)) {
      throw new ArtifactUploadError('path_outside_workspace', 'Artifact files must remain inside the authorized workspace.')
    }
    let stat
    try { stat = fs.statSync(real) }
    catch { throw new ArtifactUploadError('file_not_found', 'An artifact file does not exist.') }
    if (!stat.isFile()) {
      throw new ArtifactUploadError('not_a_regular_file', 'Only regular files can be uploaded.')
    }
    if (seen.has(real)) continue
    seen.add(real)
    totalBytes += stat.size
    if (totalBytes > maxTotalBytes) {
      throw new ArtifactUploadError(
        'files_too_large',
        `Artifacts may total at most ${Math.floor(maxTotalBytes / (1024 * 1024))} MiB per upload.`,
      )
    }
    files.push({ path: real, filename: safeFilename(real), size: stat.size })
  }
  return files
}

export function createArtifactGrantStore({
  now = () => Date.now(),
  token = () => crypto.randomBytes(24).toString('base64url'),
  ttlMs = ARTIFACT_GRANT_TTL_MS,
} = {}) {
  const grants = new Map()

  function prune() {
    const current = now()
    for (const [key, grant] of grants) {
      if (grant.expiresAt <= current) grants.delete(key)
    }
  }

  function issue(fields) {
    prune()
    const workspaceRoot = canonicalDirectory(fields.workspaceRoot)
    if (!fields.sessionId || !fields.channelId || !fields.provider || !fields.userId) {
      throw new ArtifactUploadError('invalid_grant_context', 'The Slack upload context is incomplete.')
    }
    let key = ''
    for (let attempt = 0; attempt < 20 && (!key || grants.has(key)); attempt++) key = token()
    if (!key || grants.has(key)) throw new Error('could not create a unique artifact grant')
    const grant = {
      sessionId: fields.sessionId,
      channelId: fields.channelId,
      provider: fields.provider,
      userId: fields.userId,
      messageTs: fields.messageTs || null,
      threadTs: fields.threadTs || null,
      workspaceRoot,
      expiresAt: now() + ttlMs,
      inFlight: false,
    }
    grants.set(key, grant)
    return { token: key, expiresAt: grant.expiresAt }
  }

  function claim(key, binding) {
    prune()
    const grant = typeof key === 'string' ? grants.get(key) : null
    const matches = grant && grant.sessionId === binding.sessionId &&
      grant.channelId === binding.channelId && grant.provider === binding.provider
    if (!matches) {
      throw new ArtifactUploadError('invalid_grant', 'The upload grant is invalid, expired, or belongs to another session.', 403)
    }
    if (grant.inFlight) {
      throw new ArtifactUploadError('grant_in_use', 'This upload grant is already being used.', 409)
    }
    grant.inFlight = true
    return { ...grant }
  }

  function finish(key, consume) {
    const grant = grants.get(key)
    if (!grant) return
    if (consume) grants.delete(key)
    else grant.inFlight = false
  }

  return { issue, claim, finish, prune, size: () => grants.size }
}

export async function fulfillArtifactUpload(store, { token, binding, paths }, uploader) {
  const grant = store.claim(token, binding)
  try {
    const files = resolveArtifactFiles(grant.workspaceRoot, paths)
    await uploader({ grant, files })
    store.finish(token, true)
    return {
      filenames: files.map(file => file.filename),
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    }
  } catch (error) {
    store.finish(token, false)
    throw error
  }
}

export function slackArtifactUploadOptions(grant, files) {
  if (!grant?.channelId || !grant?.userId || !Array.isArray(files) || !files.length) {
    throw new ArtifactUploadError('invalid_upload', 'The authorized Slack upload is incomplete.')
  }
  const display = files
    .map(file => `\`${String(file.filename).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, "'")}\``)
    .join(' · ')
  const options = {
    channel_id: grant.channelId,
    initial_comment: `📎 Generated for <@${grant.userId}>: ${display}`,
  }
  if (grant.threadTs) options.thread_ts = grant.threadTs
  if (files.length === 1) {
    options.file = files[0].path
    options.filename = files[0].filename
    options.title = files[0].filename
  } else {
    options.file_uploads = files.map(file => ({
      file: file.path, filename: file.filename, title: file.filename,
    }))
  }
  return options
}

export function artifactDeliveryInstruction(token) {
  return [
    '',
    '[Slack Agent Bridge artifact delivery]',
    'If and only if this Slack request explicitly asks you to return generated files, create them inside the current workspace and then run:',
    `sab-upload --grant ${token} -- FILE_PATH [FILE_PATH ...]`,
    'The destination is fixed to this Slack conversation. Do not reveal, quote, or reuse the grant, and do not run the command otherwise.',
  ].join('\n')
}
