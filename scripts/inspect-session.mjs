/*
 * 读一条会话日志，数事件类型（排查「轮数」统计用）。
 * 用法：node scripts/inspect-session.mjs <sessionId> [workspaceSlug]
 *
 * session.v4.jsonl.zstd 是多帧 zstd 拼接，要先按 magic 28 B5 2F FD 切片再逐帧解压。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('用法：node scripts/inspect-session.mjs <sessionId>')
  process.exit(1)
}

const root = join(homedir(), '.dsh', 'sessions')
const found = []
for (const workspace of readdirSync(root, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  const base = join(root, workspace.name)
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!entry.name.includes(sessionId) && entry.name !== `session-${sessionId}`) continue
    const dir = join(base, entry.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.zstd')) continue
      const path = join(dir, file)
      found.push({ path, size: statSync(path).size })
    }
  }
}

if (!found.length) {
  console.error(`没找到 ${sessionId} 的日志`)
  process.exit(1)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const text = []
for (const file of found) {
  const buffer = readFileSync(file.path)
  const cuts = []
  for (let i = 0; i < buffer.length - 4; i += 1) {
    if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i)
  }
  for (let i = 0; i < cuts.length; i += 1) {
    const slice = buffer.subarray(cuts[i], i + 1 < cuts.length ? cuts[i + 1] : buffer.length)
    try {
      text.push(zstdDecompressSync(slice).toString('utf8'))
    } catch (error) {
      console.error(`第 ${i} 帧解压失败：${error.message}`)
    }
  }
}

const counts = new Map()
const samples = new Map()
let lines = 0
for (const chunk of text) {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    lines += 1
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = record.type || record.event?.type || '(无 type)'
    counts.set(type, (counts.get(type) || 0) + 1)
    if (!samples.has(type)) samples.set(type, JSON.stringify(record).slice(0, 260))
  }
}

console.log(`文件：${found.map((f) => `${f.path} (${f.size} B)`).join('、')}`)
console.log(`行数：${lines}，事件类型 ${counts.size} 种`)
for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(5)}  ${type}`)
}
console.log('\n样例：')
for (const [type, sample] of samples) console.log(`  ${type}: ${sample}`)
