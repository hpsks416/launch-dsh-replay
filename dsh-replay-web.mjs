#!/usr/bin/env node
/**
 * DSH session replay — offline guide page + one-click renderer.
 *
 * Lists the sessions in `~/.dsh/sessions` (desktop DSH v4 logs first, older v3
 * logs too), and renders a clicked session into a self-contained HTML timeline
 * (the vendored `@mingozhou/dsh-replay` viewer, MIT). Read-only: the original
 * `session.v*.jsonl.zstd` is never modified; output goes to %TEMP%.
 *
 * Zero dependencies — Node ≥ 22.19 (bundled zstd only).
 *
 *   node dsh-replay-web.mjs [--port 7781] [--limit 40] [--no-open]
 *
 * Env: DSH_REPLAY_PORT / DSH_REPLAY_ROOT / DSH_REPLAY_OUT
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  discoverSessions,
  peekAll,
  parseSessionFile,
  summarize,
  buildReplayHtml,
  sessionsRoot,
  outputDir,
} from './lib/sessions.mjs'

const SERVICE = 'launch-dsh-replay'
const VERSION = '1.1.0'

function parseArgs (argv) {
  const options = { port: Number(process.env.DSH_REPLAY_PORT ?? 7781), limit: 40, open: true, root: sessionsRoot() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') options.port = Number(argv[++i])
    else if (arg === '--limit') options.limit = Number(argv[++i])
    else if (arg === '--root') options.root = argv[++i]
    else if (arg === '--no-open') options.open = false
  }
  if (!Number.isFinite(options.port) || options.port <= 0) options.port = 7781
  return options
}

const options = parseArgs(process.argv.slice(2))
const HOST = '127.0.0.1'
process.title = 'DSH Session Replay'

const htmlCache = new Map() // cacheKey -> { html, stats }

function esc (value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function fmtMb (bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function fmtTime (ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Sessions + cheap metadata for the guide page, newest first. */
function listSessions () {
  const all = discoverSessions(options.root)
  const shown = all.slice(0, options.limit)
  const metas = peekAll(shown)
  return shown.map((session, index) => ({ ...session, meta: metas[index] }))
}

function findSession (key) {
  const all = discoverSessions(options.root)
  return all.find(session => session.id === key) ?? null
}

function guideHtml (sessions) {
  const rows = sessions.map((session, index) => {
    const meta = session.meta
    const title = meta.title || (meta.id ? meta.id : session.id)
    const cwd = meta.cwd || session.workspacePath || '—'
    const badge = `<span class="badge v${session.version}">v${session.version}</span>`
    const stat = fmtMb(session.size)
    const when = fmtTime(session.mtime)
    const statsUrl = `/stats?id=${encodeURIComponent(session.id)}`
    const replayUrl = `/replay?id=${encodeURIComponent(session.id)}`
    return `<div class="item">
      <div class="item-main">
        <a class="title" href="${replayUrl}">${esc(title)}</a>
        <div class="sub">${badge}<code>${esc(shortId(meta.id || session.id))}</code><span class="meta-sep">·</span><span>${esc(cwd)}</span></div>
        <div class="sub dim">${stat} · ${when}</div>
      </div>
      <div class="actions">
        <a class="btn primary" href="${replayUrl}">回放</a>
        <a class="btn" href="${statsUrl}">统计</a>
      </div>
    </div>`
  }).join('\n')

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 会话回放</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{font-family:system-ui,"Segoe UI",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
  h1{font-size:20px;margin:0 0 4px}
  .tip{color:#555;font-size:13px;margin:0 0 16px;line-height:1.6}
  .bar{display:flex;gap:12px;align-items:center;margin:0 0 14px;font-size:12px;color:#666}
  .bar code{background:#eee;padding:2px 6px;border-radius:4px;word-break:break-all}
  .item{display:flex;gap:12px;align-items:center;background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:10px 14px;margin:10px 0}
  .item-main{flex:1;min-width:0}
  .title{color:#2563eb;text-decoration:none;font-size:15px;font-weight:600;word-break:break-all}
  .title:hover{text-decoration:underline}
  .sub{color:#666;font-size:12px;margin-top:4px;word-break:break-all}
  .dim{color:#999}
  .meta-sep{margin:0 6px;color:#bbb}
  code{font-size:12px;color:#666;word-break:break-all}
  .badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:10px;margin-right:6px;color:#fff}
  .badge.v4{background:#2563eb}.badge.v3{background:#888}
  .actions{display:flex;gap:8px;flex-shrink:0}
  .btn{font-size:12px;padding:5px 12px;border:1px solid #d0d0d0;border-radius:6px;color:#333;text-decoration:none;background:#f6f6f6}
  .btn:hover{background:#eee}
  .btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
  .btn.primary:hover{background:#1d4ed8}
  .empty{background:#fff;border:1px dashed #ccc;border-radius:8px;padding:24px;text-align:center;color:#888}
  footer{margin:24px 0 8px;font-size:12px;color:#999;line-height:1.7}
</style></head><body>
<h1>DSH 会话回放 · 离线可视化引导页</h1>
<p class="tip">点选一个会话，自动渲染 turn → step → 工具调用时间线。<b>只读</b>：不覆盖原日志，输出到 <code>%TEMP%\\dsh-replay-out\\</code>。首次渲染大会话可能需要几秒。</p>
<div class="bar">
  <span>会话根 <code>${esc(options.root)}</code></span>
  <span>·</span>
  <span>共 ${sessions.length} 个（最近优先）</span>
</div>
${rows || '<div class="empty">没有找到会话日志（检查 DSH_REPLAY_ROOT 或是否已有对话）</div>'}
<footer>
  v4 = 桌面端 DSH（dsh-desktop 0.2.x）会话；v3 = 旧版 WEB DSH 会话。<br>
  渲染引擎：<a href="https://github.com/MingoZhou/dsh-replay">@mingozhou/dsh-replay</a> 0.4.2（MIT，离线内联）。
</footer>
</body></html>`
}

function shortId (id) {
  const s = String(id ?? '')
  if (s.length <= 22) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

function renderSessionHtml (session) {
  const stat = statSync(session.file)
  const cacheKey = `${session.file}|${stat.mtimeMs}|${stat.size}`
  const cached = htmlCache.get(cacheKey)
  if (cached) return cached
  const parsed = parseSessionFile(session.file)
  const stats = summarize(parsed)
  const html = buildReplayHtml(
    [{ header: parsed.header, events: parsed.events, title: stats.title }],
    { lang: 'zh', title: stats.title },
  )
  const entry = { html, stats }
  htmlCache.set(cacheKey, entry)
  // Also persist next to other renders so it can be opened/shared later.
  try {
    const file = join(outputDir(), `${String(stats.id ?? session.id).replace(/[^\w.-]+/g, '_')}.html`)
    mkdirSync(outputDir(), { recursive: true })
    writeFileSync(file, html)
    entry.outputFile = file
  } catch { /* read-only temp is fine */ }
  return entry
}

function sendJson (res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

async function probeExisting (port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const body = await response.json()
    return body?.service === SERVICE
  } catch {
    return false
  }
}

function openBrowser (url) {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  const child = spawn(command, args, {
    shell: process.platform === 'win32',
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
}

let activePort = options.port

function startServer (port, remainingTries = 5) {
  activePort = port
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`)
    try {
      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: SERVICE, version: VERSION, root: options.root, port: activePort })
        return
      }
    if (url.pathname === '/') {
      const sessions = listSessions()
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(guideHtml(sessions))
      return
    }
    if (url.pathname === '/replay') {
      const key = url.searchParams.get('id')
      const session = key ? findSession(key) : null
      if (!session) { sendJson(res, 404, { error: 'session not found', id: key }); return }
      const started = Date.now()
      const { html, stats } = renderSessionHtml(session)
      console.log(`rendered ${stats.id} (${html.length} bytes, ${Date.now() - started} ms)`)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
      return
    }
    if (url.pathname === '/stats') {
      const key = url.searchParams.get('id')
      const session = key ? findSession(key) : null
      if (!session) { sendJson(res, 404, { error: 'session not found', id: key }); return }
      const parsed = parseSessionFile(session.file)
      sendJson(res, 200, summarize(parsed))
      return
    }
    sendJson(res, 404, { error: 'not found', path: url.pathname })
  } catch (error) {
    console.error('request failed:', error?.stack ?? error)
    sendJson(res, 500, { error: String(error?.message ?? error) })
  }
})

  server.on('error', async (error) => {
    if (error?.code === 'EADDRINUSE') {
      const ours = await probeExisting(port)
      if (ours) {
        console.log(`service already running at http://${HOST}:${port}/ — opening browser`)
        openBrowser(`http://${HOST}:${port}/`)
        process.stdin.resume() // keep the window alive instead of flashing closed
        return
      }
      if (remainingTries > 0) {
        console.log(`port ${port} is busy (another program) — trying ${port + 1}`)
        startServer(port + 1, remainingTries - 1)
        return
      }
      console.error(`no free port in ${options.port}..${port}. retry with: node dsh-replay-web.mjs --port <n>`)
      process.exitCode = 1
      return
    }
    console.error('server error:', error?.message ?? error)
    process.exitCode = 1
  })

  server.listen(port, HOST, () => {
    const address = `http://${HOST}:${port}/`
    console.log('DSH Session Replay — offline guide')
    console.log(`  guide URL:  ${address}`)
    console.log(`  sessions:   ${options.root}`)
    console.log(`  output:     ${outputDir()}`)
    console.log('  read-only:  original session logs are never modified')
    console.log('Press Ctrl+C to stop.')
    if (options.open) openBrowser(address)
  })
}

startServer(options.port)

