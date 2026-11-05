/**
 * Session discovery / parsing / offline-HTML rendering.
 *
 * Parsing and the timeline model come from the vendored, v4-native
 * `@mingozhou/dsh-replay` core (MIT — see vendor/dsh-replay/LICENSE). This
 * module only adds what the offline launcher needs: where DSH keeps logs,
 * per-session metadata for the guide page, and a single-file HTML export that
 * inlines the upstream viewer bundle (the same contract as the plugin's own
 * "Export HTML" action).
 */

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readHead, decodeContainerPrefix, decodeSessionText } from './decode.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = join(HERE, '..')
const VENDOR_DIR = join(PROJECT_DIR, 'vendor', 'dsh-replay')

const core = await import(pathToFileURL(join(VENDOR_DIR, 'core.js')).href)
const { parseSessionJsonl, buildTimeline, auditSession } = core

/**
 * Session root resolution, most specific first:
 *   DSH_REPLAY_ROOT → DSH_HOME/sessions → ~/.dsh/sessions
 * DSH_HOME is the variable the DSH CLI itself uses (`$DSH_HOME/profiles`), so a
 * custom data directory works without extra flags.
 */
export function sessionsRoot () {
  if (process.env.DSH_REPLAY_ROOT) return process.env.DSH_REPLAY_ROOT
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

/** Temp output dir for rendered HTML (never writes into the session tree). */
export function outputDir () {
  if (process.env.DSH_REPLAY_OUT) return process.env.DSH_REPLAY_OUT
  return join(tmpdir(), 'dsh-replay-out')
}

function safeStat (file) {
  try { return statSync(file) } catch { return null }
}

/**
 * Enumerate sessions under the DSH session root.
 * Prefers `session.v4.jsonl.zstd` (desktop DSH ≥ 0.2.x) and falls back to
 * `session.v3.jsonl.zstd` (older WEB builds). Backup suffixes are ignored.
 */
export function discoverSessions (root = sessionsRoot()) {
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace)
    let ids = []
    try {
      ids = readdirSync(workspaceDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch { continue }
    for (const dirName of ids) {
      const dir = join(workspaceDir, dirName)
      const v4 = join(dir, 'session.v4.jsonl.zstd')
      const v3 = join(dir, 'session.v3.jsonl.zstd')
      const file = existsSync(v4) ? v4 : (existsSync(v3) ? v3 : null)
      if (!file) continue
      const stat = safeStat(file)
      if (!stat) continue
      out.push({
        id: dirName,
        dir,
        file,
        version: file === v4 ? 4 : 3,
        size: stat.size,
        mtime: stat.mtimeMs,
        workspace,
        workspacePath: workspace.replace(/^--/, '').replace(/--$/, ''),
      })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/* ------------------------------------------------------------------ *
 * Metadata peek (header + early session/title), cached on disk by mtime
 * ------------------------------------------------------------------ */

function titlesCachePath () {
  return join(tmpdir(), 'dsh-replay-meta-cache.json')
}

function loadMetaCache () {
  try { return JSON.parse(readFileSync(titlesCachePath(), 'utf8')) } catch { return {} }
}

function saveMetaCache (cache) {
  try { writeFileSync(titlesCachePath(), JSON.stringify(cache)) } catch { /* best effort */ }
}

let metaCache = loadMetaCache()

/** Cheap header/title peek for one session file (cached by path + mtime + size). */
export function peekMeta (session) {
  const key = session.file
  const cached = metaCache[key]
  if (cached && cached.mtime === session.mtime && cached.size === session.size) return cached
  let meta = { mtime: session.mtime, size: session.size, id: session.id, version: session.version, cwd: undefined, title: undefined, createdAt: undefined }
  try {
    const head = readHead(session.file, 2 * 1024 * 1024)
    const text = decodeContainerPrefix(head, { maxFrames: 12, maxChars: 48 * 1024 * 1024 })
    let header = null
    let title = null
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let value
      try { value = JSON.parse(line) } catch { continue }
      if (!header && value?.type === 'session') { header = value; continue }
      if (value?.type === 'session/title' && typeof value.data?.title === 'string') title = value.data.title
    }
    if (header) {
      meta = {
        ...meta,
        id: typeof header.id === 'string' ? header.id : session.id,
        cwd: header.cwd,
        createdAt: header.createdAt,
        version: header.version ?? session.version,
        title: title ?? undefined,
      }
    } else if (title) {
      meta.title = title
    }
  } catch { /* keep stub meta */ }
  metaCache[key] = meta
  return meta
}

/** Peek metadata for many sessions, persisting the cache once. */
export function peekAll (sessions) {
  const before = JSON.stringify(metaCache)
  const metas = sessions.map(session => peekMeta(session))
  if (JSON.stringify(metaCache) !== before) saveMetaCache(metaCache)
  return metas
}

/* ------------------------------------------------------------------ *
 * Parse + stats
 * ------------------------------------------------------------------ */

const parsedCache = new Map() // file -> { mtime, size, parsed }

/** Full parse (JSONL → header + seq-ordered events), cached by mtime. */
export function parseSessionFile (file) {
  const stat = safeStat(file)
  if (!stat) throw new Error(`session file not found: ${file}`)
  const cached = parsedCache.get(file)
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.parsed
  const text = decodeSessionText(file)
  const parsed = parseSessionJsonl(text)
  parsedCache.set(file, { mtime: stat.mtimeMs, size: stat.size, parsed })
  return parsed
}

/** Turn-level + token + audit summary for one parsed session. */
export function summarize (parsed) {
  const timeline = buildTimeline(parsed)
  const audit = auditSession(parsed)
  return {
    id: parsed.header.id,
    title: timeline.title,
    formatVersion: parsed.header.version,
    cwd: parsed.header.cwd,
    createdAt: parsed.header.createdAt,
    events: parsed.events.length,
    malformed: parsed.malformed.length,
    turns: timeline.turns.length,
    steps: timeline.turns.reduce((n, turn) => n + turn.steps.length, 0),
    toolCalls: timeline.toolCalls.length,
    toolErrors: timeline.toolCalls.filter(call => call.error !== undefined).length,
    approvals: timeline.items.filter(item => item.type === 'approval/asked').length,
    durationMs: timeline.durationMs,
    models: timeline.models,
    tokens: timeline.totals,
    audit: { findings: audit.findings.length, counts: audit.counts },
    startTime: timeline.startTime,
    endTime: timeline.endTime,
  }
}

/* ------------------------------------------------------------------ *
 * Offline single-file HTML export (upstream viewer contract)
 * ------------------------------------------------------------------ */

let viewerSourceCache = null

/** The inlined standalone viewer bundle (React included, ~420 KB). */
export function viewerSource () {
  if (viewerSourceCache === null) {
    viewerSourceCache = readFileSync(join(VENDOR_DIR, 'viewer.js'), 'utf8')
  }
  return viewerSourceCache
}

function escapeHtml (value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
}

/**
 * Build a self-contained HTML document: `window.__DSHR_DATA__` + the inlined
 * viewer bundle. This mirrors the upstream plugin's own export template, so the
 * offline file behaves exactly like the in-app "Export HTML" download.
 */
export function buildReplayHtml (exportSessions, { lang = 'zh', title } = {}) {
  const viewer = viewerSource()
  const data = JSON.stringify({ sessions: exportSessions }).replaceAll('<', '\\u003c')
  const source = viewer.replaceAll('</script>', '<\\/script>')
  const docTitle = title ?? exportSessions[0]?.title ?? 'session replay'
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="DSH session replay (offline export)" />
<title>${escapeHtml(docTitle)} — DSH 会话回放</title>
<style>html, body, #root { height: 100%; margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }</style>
</head>
<body>
<div id="root"></div>
<script>window.__DSHR_DATA__ = ${data}<\/script>
<script>${source}<\/script>
</body>
</html>
`
}

/** Render one session file into a self-contained HTML file. */
export function renderToFile (file, outFile, options = {}) {
  const parsed = parseSessionFile(file)
  const stats = summarize(parsed)
  const html = buildReplayHtml(
    [{ header: parsed.header, events: parsed.events, title: options.title ?? stats.title }],
    { lang: options.lang ?? 'zh', title: options.title ?? stats.title },
  )
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, html)
  return { outFile, bytes: html.length, stats }
}

/** Default output path for a rendered session. */
export function defaultOutFile (sessionOrId, file) {
  const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id
  const name = (id || basename(dirname(file ?? ''))).replace(/[^\w.-]+/g, '_')
  return join(outputDir(), `${name}.html`)
}
