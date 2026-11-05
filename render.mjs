#!/usr/bin/env node
/**
 * DSH session replay — command line front end for the same offline renderer.
 *
 *   node render.mjs --list [--json]                       list sessions
 *   node render.mjs --latest [--out replay.html]          render newest session
 *   node render.mjs --id <session-id> [--out replay.html] render one session
 *   node render.mjs --file <session.v4.jsonl.zstd> [--out replay.html]
 *   node render.mjs --file <path> --stats                 print stats JSON only
 *
 * Read-only: the session log is decoded to memory; only the HTML output file is
 * written (default: %TEMP%\dsh-replay-out\<id>.html).
 */

import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import {
  discoverSessions,
  peekAll,
  parseSessionFile,
  summarize,
  renderToFile,
  defaultOutFile,
  sessionsRoot,
} from './lib/sessions.mjs'

function fail (message) {
  process.stderr.write(`render.mjs: ${message}\n`)
  process.exit(1)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`DSH session replay — render a session log to offline HTML

Usage:
  node render.mjs --list [--json]                        list sessions (newest first)
  node render.mjs --latest [--out replay.html]           render the newest session
  node render.mjs --id <session-id> [--out replay.html]  render one session by id
  node render.mjs --file <session.v4.jsonl.zstd> [--out replay.html]
  node render.mjs --file <path> --stats                  print stats JSON only

Options:
  --root <dir>   sessions root (default: $DSH_HOME/sessions or ~/.dsh/sessions)
  --out <file>   HTML output path (default: %TEMP%\\\\dsh-replay-out\\\\<session-id>.html)
  --json         with --list: machine-readable output

Env: DSH_REPLAY_ROOT / DSH_REPLAY_OUT
`)
  process.exit(0)
}

function value (name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const root = value('--root') ?? sessionsRoot()
const asJson = argv.includes('--json')

function findById (id) {
  const sessions = discoverSessions(root)
  const direct = sessions.find(session => session.id === id || session.file === id)
  if (direct) return direct
  const metas = peekAll(sessions)
  const index = sessions.findIndex((session, i) => metas[i].id === id)
  return index >= 0 ? sessions[index] : null
}

if (argv.includes('--list')) {
  const sessions = discoverSessions(root).slice(0, 200)
  const metas = peekAll(sessions)
  if (asJson) {
    process.stdout.write(JSON.stringify(sessions.map((session, i) => ({
      id: metas[i].id ?? session.id,
      dir: session.dir,
      version: session.version,
      size: session.size,
      mtime: session.mtime,
      title: metas[i].title,
      cwd: metas[i].cwd,
      file: session.file,
    })), null, 2) + '\n')
  } else {
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i]
      const meta = metas[i]
      const title = meta?.title ? meta.title.slice(0, 60) : '(untitled)'
      process.stdout.write(`v${session.version}  ${new Date(session.mtime).toISOString()}  ${title}  [${session.id}]\n`)
    }
  }
  process.exit(0)
}

const fileArg = value('--file')
const idArg = value('--id')
let session = null
let file = null

if (fileArg) {
  file = resolve(fileArg)
  if (!existsSync(file)) fail(`file not found: ${file}`)
} else {
  const wanted = idArg
  if (wanted) {
    session = findById(wanted)
    if (!session) fail(`no session found for "${wanted}" under ${root}`)
    file = session.file
  } else if (argv.includes('--latest')) {
    const sessions = discoverSessions(root)
    if (sessions.length === 0) fail(`no sessions found under ${root}`)
    session = sessions[0]
    file = session.file
  } else {
    fail('need one of --list / --latest / --id <id> / --file <path>')
  }
}

if (argv.includes('--stats')) {
  const parsed = parseSessionFile(file)
  process.stdout.write(JSON.stringify(summarize(parsed), null, 2) + '\n')
  process.exit(0)
}

const out = resolve(value('--out') ?? defaultOutFile(session?.id ?? file, file))
const started = Date.now()
const result = renderToFile(file, out, { lang: 'zh' })
process.stdout.write(`${result.outFile}\n`)
process.stdout.write(`  session: ${result.stats.id}${result.stats.title ? ` — ${result.stats.title}` : ''}\n`)
process.stdout.write(`  turns: ${result.stats.turns}  steps: ${result.stats.steps}  tool calls: ${result.stats.toolCalls}  errors: ${result.stats.toolErrors}\n`)
process.stdout.write(`  html: ${(result.bytes / 1048576).toFixed(2)} MB  (${Date.now() - started} ms, ${root})\n`)
