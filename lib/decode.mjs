/**
 * Concatenated-Zstandard container decoding for DSH session logs.
 *
 * DSH writes `session.v*.jsonl.zstd` as a sequence of independent Zstandard
 * frames (one per flushed write). Node's zlib decodes only the first frame of a
 * buffer, so we walk the frame headers ourselves and decompress frame by frame.
 * The walker is bounds-safe and tolerates a torn tail (session still being
 * written) — the torn frame is dropped, matching the harness's committed-bytes
 * semantics.
 */

import { openSync, readSync, closeSync, fstatSync, readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** Walk frame boundaries. Returns complete frames, plus the offset of a torn frame. */
export function scanZstdFrames (buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      return { frames, tornStart: start, invalidMagic: offset }
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Decode a whole concatenated-frame container into UTF-8 text. */
export function decodeContainer (buffer) {
  const { frames } = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Read at most `maxBytes` from the head of a file. */
export function readHead (file, maxBytes) {
  const fd = openSync(file, 'r')
  try {
    const size = Math.min(fstatSync(fd).size, maxBytes)
    const buffer = Buffer.alloc(size)
    const read = readSync(fd, buffer, 0, size, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * Decode a bounded prefix of a container — enough for the session header and an
 * early `session/title` event, without decompressing a multi-megabyte log.
 * Frames are decoded in order and the scan stops once `maxFrames` or
 * `maxChars` is reached.
 */
export function decodeContainerPrefix (buffer, { maxFrames = 24, maxChars = 32 * 1024 * 1024 } = {}) {
  const { frames } = scanZstdFrames(buffer)
  let text = ''
  let used = 0
  for (const frame of frames) {
    if (used >= maxFrames || text.length >= maxChars) break
    try {
      text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      break
    }
    used++
  }
  return text
}

/** Decode a plain (uncompressed) or zstd JSONL session artifact to text. */
export function decodeSessionText (file) {
  const buffer = readFileSync(file)
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    return decodeContainer(buffer)
  }
  return buffer.toString('utf8')
}
