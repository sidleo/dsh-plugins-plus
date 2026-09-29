#!/usr/bin/env node
/**
 * Minimal Electron `asar` reader — used by the T4 review to prove that the DSH
 * install bundled inside the desktop app (`app.asar/dsh/node_modules/@deepseek-ai`)
 * is the same build as the one under `~/.local/lib/node_modules`.
 *
 * Usage:
 *   node reports/asar-read.mjs <archive.asar> versions
 *   node reports/asar-read.mjs <archive.asar> list   <path-prefix>
 *   node reports/asar-read.mjs <archive.asar> hash   <exact/relative/path.js>
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const [, , archive, mode, arg] = process.argv
if (archive === undefined || mode === undefined) {
  console.error('usage: asar-read.mjs <archive.asar> versions|list|hash [arg]')
  process.exit(2)
}

const fd = fs.openSync(archive, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const baseOffset = 8 + headerSize

const list = []
;(function walk(node, path) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = path === '' ? name : `${path}/${name}`
    if (child.files !== undefined) walk(child, p)
    else list.push({ p, child })
  }
})(header, '')

/** Read one entry; throws for entries stored outside the archive (unpacked native modules). */
function read(entry, max = 1 << 30) {
  if (entry.child.offset === undefined) throw new Error(`unpacked (no offset): ${entry.p}`)
  const size = Math.min(entry.child.size, max)
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, baseOffset + Number(entry.child.offset))
  return buf
}

if (mode === 'list') {
  console.log(list.filter(e => e.p.startsWith(arg ?? '')).map(e => e.p).join('\n'))
} else if (mode === 'versions') {
  const out = []
  for (const entry of list) {
    const m = /^dsh\/node_modules\/@deepseek-ai\/([^/]+)\/package\.json$/.exec(entry.p)
    if (m === null) continue
    try {
      out.push(`${m[1]}@${JSON.parse(read(entry, 200000).toString('utf8')).version}`)
    } catch (error) {
      out.push(`${m[1]}@<${error.message}>`)
    }
  }
  console.log(out.sort().join('\n'))
  console.error(`count=${out.length}`)
} else if (mode === 'hash') {
  const hits = list.filter(e => e.p === arg)
  if (hits.length === 0) console.error(`not found: ${arg}`)
  for (const entry of hits) {
    console.log(`${crypto.createHash('sha256').update(read(entry)).digest('hex')}  ${entry.p}`)
  }
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
