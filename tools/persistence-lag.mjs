#!/usr/bin/env node
/**
 * Persistence-lag probe: how far behind "now" is the last committed session
 * event on disk? Used to measure the crash window before/after installing the
 * `dsh-session-sync-flush` plugin.
 *
 *   node tools/persistence-lag.mjs [--root <sessions>] [--limit 3] [--json]
 *
 * Read-only: opens session logs read-only, decodes complete zstd frames only.
 * Exit code 0 always (diagnostic tool).
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsRoot } from '../lib/sessions.mjs'
import { discoverSessions } from '../lib/sessions.mjs'
import { decodeContainer, scanZstdFrames, readHead } from '../lib/decode.mjs'

function parseArgs (argv) {
  const options = { root: sessionsRoot(), limit: 3, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') options.root = argv[++i]
    else if (arg === '--limit') options.limit = Math.max(1, Number(argv[++i]) || 3)
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`usage: node tools/persistence-lag.mjs [--root <sessions>] [--limit 3] [--json]

Prints, for the newest session logs: last committed event time/seq, how far behind
"now" it is, frame count, and whether the tail is torn (crash-truncated).`)
      process.exit(0)
    }
  }
  return options
}

/** Read only the tail of a file (frames are small; 8 MB covers long sessions). */
function readTail (file, maxBytes = 8 * 1024 * 1024) {
  const size = statSync(file).size
  return readHead(file, Math.min(size, maxBytes))
}

function measure (session) {
  const buffer = readTail(session.file)
  const truncatedHead = statSync(session.file).size > buffer.length
  const { frames, tornStart } = scanZstdFrames(buffer)
  let text = ''
  for (const frame of frames) text += decodeContainer(buffer.subarray(frame.start, frame.end))
  const lines = text.split('\n').filter(Boolean)
  let last = null
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!last || (event.time ?? 0) >= (last.time ?? 0)) last = event
  }
  const now = Date.now()
  return {
    id: session.id,
    file: session.file,
    formatVersion: session.version,
    bytes: statSync(session.file).size,
    frames: frames.length,
    truncatedHead,
    tornTail: tornStart !== undefined,
    eventsInTail: lines.length,
    lastEvent: last ? { type: last.type, seq: last.seq, time: last.time, iso: new Date(last.time).toISOString() } : null,
    mtime: new Date(session.mtime).toISOString(),
    lagMs: last ? now - last.time : null,
    mtimeLagMs: now - session.mtime,
  }
}

const options = parseArgs(process.argv.slice(2))
const sessions = discoverSessions(options.root).slice(0, options.limit)
const results = sessions.map(measure)

if (options.json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  console.log(`now: ${new Date().toISOString()}`)
  console.log(`sessions root: ${options.root}`)
  for (const r of results) {
    console.log('---')
    console.log(`session: ${r.id} (v${r.formatVersion})`)
    console.log(`  bytes=${r.bytes} frames=${r.frames} tornTail=${r.tornTail}${r.truncatedHead ? ' (tail-window)' : ''}`)
    if (r.lastEvent) {
      console.log(`  last event: ${r.lastEvent.type} seq=${r.lastEvent.seq} at ${r.lastEvent.iso}`)
      console.log(`  lag: ${(r.lagMs / 1000).toFixed(1)}s (mtime ${(r.mtimeLagMs / 1000).toFixed(1)}s)`)
    }
  }
}
