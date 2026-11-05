#!/usr/bin/env node
/**
 * Self-test / smoke test — no dependencies, no network, no DSH required.
 *
 *   node tests/smoke.mjs
 *
 * Verifies, in-process and against a synthetic log:
 *   1. concatenated-zstd frame decoding (Node's built-in zstd stops after one frame)
 *   2. DSH v4 parsing: title, turns, steps, tool call ↔ tool result linkage
 *   3. summarize() counters
 *   4. single-file HTML export embeds the data + the vendored viewer
 *   5. session-root resolution order: DSH_REPLAY_ROOT → DSH_HOME/sessions → ~/.dsh/sessions
 *
 * Exit code 0 = all good.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { parseSessionFile, summarize, renderToFile, sessionsRoot } from '../lib/sessions.mjs'
import { decodeContainer } from '../lib/decode.mjs'

const events = [
  { type: 'session', version: 4, id: 'session-smoke-fixture', createdAt: 1790000000000, cwd: 'C:\\smoke', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
  { type: 'permission/preset', seq: 0, time: 1790000000001, data: { preset: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 1790000000002, data: { turn: 1 } },
  { type: 'session/title', seq: 2, time: 1790000000003, data: { title: 'smoke fixture', messageSeqs: [3] } },
  { type: 'user/message', seq: 3, time: 1790000000004, data: { content: [{ type: 'text', text: 'hello smoke' }], source: { kind: 'user' }, role: 'user', id: 'u1' } },
  { type: 'step/start', seq: 4, time: 1790000000005, data: { turn: 1, step: 1 } },
  {
    type: 'assistant/message', seq: 5, time: 1790000000006,
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking about the smoke test' },
          { type: 'tool-call', id: 'call_smoke_1', name: 'read', arguments: '{"file_path":"a.txt"}' },
        ],
      },
    },
  },
  { type: 'tool/call', seq: 6, time: 1790000000007, data: { turn: 1, step: 1, callId: 'call_smoke_1', name: 'read', arguments: '{"file_path":"a.txt"}' } },
  {
    type: 'tool/result', seq: 7, time: 1790000000008,
    data: {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'call_smoke_1', content: [{ type: 'text', text: 'file contents' }], isError: false },
      surfaceOp: 'append',
    },
  },
  { type: 'step/end', seq: 8, time: 1790000000009, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 9, time: 1790000000010, data: { turn: 1, reason: { kind: 'completed' } } },
]

const checks = []
function check (name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
    process.stdout.write(`PASS  ${name}\n`)
  } catch (error) {
    checks.push({ name, ok: false, error })
    process.stdout.write(`FAIL  ${name}\n      ${error.message}\n`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-replay-smoke-'))
const jsonlPath = join(dir, 'session.v4.jsonl')
const zstdPath = join(dir, 'session.v4.jsonl.zstd')
const htmlPath = join(dir, 'out.html')

writeFileSync(jsonlPath, events.map(event => JSON.stringify(event)).join('\n') + '\n')
// one zstd frame per line — exactly how DSH flushes a live session
writeFileSync(zstdPath, Buffer.concat(events.map(event => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))))

check('concatenated zstd frames decode to every line', () => {
  const text = decodeContainer(readFileSync(zstdPath))
  const lines = text.split('\n').filter(Boolean)
  assert.equal(lines.length, events.length)
  assert.equal(JSON.parse(lines[0]).type, 'session')
})

check('v4 header + title are parsed', () => {
  const parsed = parseSessionFile(zstdPath)
  assert.equal(parsed.header.version, 4)
  assert.equal(parsed.header.id, 'session-smoke-fixture')
  assert.equal(parsed.malformed.length, 0)
})

check('v4 tool result links to its tool call (not just "last call")', () => {
  const stats = summarize(parseSessionFile(zstdPath))
  assert.equal(stats.turns, 1)
  assert.equal(stats.steps, 1)
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.toolErrors, 0)
  assert.equal(stats.title, 'smoke fixture')
})

check('single-file HTML export embeds data + vendored viewer', () => {
  const result = renderToFile(zstdPath, htmlPath)
  const html = readFileSync(htmlPath, 'utf8')
  assert.ok(html.includes('window.__DSHR_DATA__'), 'missing __DSHR_DATA__ bootstrap')
  assert.ok(html.includes('smoke fixture'), 'missing session title')
  assert.ok(html.includes('createRoot'), 'missing inlined viewer bundle')
  assert.ok(result.bytes > 400_000, `viewer bundle too small: ${result.bytes} bytes`)
})

check('plain (uncompressed) JSONL session works too', () => {
  const stats = summarize(parseSessionFile(jsonlPath))
  assert.equal(stats.toolCalls, 1)
  assert.equal(stats.title, 'smoke fixture')
})

check('session root resolution: DSH_REPLAY_ROOT wins', () => {
  const saved = { root: process.env.DSH_REPLAY_ROOT, home: process.env.DSH_HOME }
  process.env.DSH_REPLAY_ROOT = 'C:\\explicit-root'
  process.env.DSH_HOME = 'C:\\dsh-home'
  try { assert.equal(sessionsRoot(), 'C:\\explicit-root') } finally { restore(saved) }
})

check('session root resolution: DSH_HOME/sessions second', () => {
  const saved = { root: process.env.DSH_REPLAY_ROOT, home: process.env.DSH_HOME }
  delete process.env.DSH_REPLAY_ROOT
  process.env.DSH_HOME = join('C:\\', 'custom-dsh-home')
  try { assert.equal(sessionsRoot(), join('C:\\', 'custom-dsh-home', 'sessions')) } finally { restore(saved) }
})

check('session root resolution: ~/.dsh/sessions default', () => {
  const saved = { root: process.env.DSH_REPLAY_ROOT, home: process.env.DSH_HOME }
  delete process.env.DSH_REPLAY_ROOT
  delete process.env.DSH_HOME
  try { assert.equal(sessionsRoot(), join(homedir(), '.dsh', 'sessions')) } finally { restore(saved) }
})

function restore (saved) {
  if (saved.root === undefined) delete process.env.DSH_REPLAY_ROOT
  else process.env.DSH_REPLAY_ROOT = saved.root
  if (saved.home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved.home
}

try {
  rmSync(dir, { recursive: true, force: true })
} catch { /* temp cleanup is best effort */ }

const failed = checks.filter(check => !check.ok)
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
