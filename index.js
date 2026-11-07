/**
 * 卷宗 / dsh-dossier — host half.
 *
 * 职责：
 *  1. 持久化卷宗（文件夹）与会话归属：~/.dsh/dossier.json
 *  2. 给客户端提供 HTTP 接口：/dsh-dossier/state（读）、/dsh-dossier/op（写）、
 *     /dsh-dossier/handoff（把「生成交接文档」的请求投递进指定会话）
 *  3. 注册 dossier_handoff_write 工具：把 agent 写好的交接文档落盘 + 备份
 *
 * 只存元数据，不复制会话内容；会话本身仍以 DSH 会话日志为唯一真相。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-dossier'

const PREFIX = '/dsh-dossier'
const STATE_PATH = `${PREFIX}/state`
const OP_PATH = `${PREFIX}/op`
const HANDOFF_PATH = `${PREFIX}/handoff`
const USAGE_PATH = `${PREFIX}/usage`
const DOCS_PATH = `${PREFIX}/docs`
const DOC_OP_PATH = `${PREFIX}/docop`

// 这两个路径允许用环境变量改道，仅供 scripts/selftest.mjs 在临时目录里跑完整写入流程。
const STORE_PATH = process.env.DSH_DOSSIER_STORE || join(homedir(), '.dsh', 'dossier.json')
const BACKUP_ROOT = process.env.DSH_DOSSIER_BACKUP || join(homedir(), '.dsh', 'dossier', 'handoffs')
const MAX_BODY_CHARS = 400_000
const EMPTY_SESSION_MESSAGE = '这条对话还没有可交接的内容：先让它做点事，再交接。'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
/* 卷宗内的排序：手动（默认，可 ↑↓）/ 按更新时间 / 按名称 */
const FOLDER_SORTS = new Set(['manual', 'time', 'name'])

const DEFAULTS = {
  handoffRoot: 'goals',
  maxHandoffTokens: 1800,
  handoffPrompt:
    '【卷宗·交接】请生成交接文档：调用 dossier_handoff_write（骨架与硬规则见工具说明），写完只回一句确认。',
}

/* ------------------------------------------------------------------ 纯工具 */

export function slugify(input, maxLen = 24) {
  const raw = String(input == null ? '' : input)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 保留中英文数字，其余折叠成 '-'
  const cleaned = raw
    .replace(/[^\p{Script=Han}\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const out = Array.from(cleaned).slice(0, maxLen).join('')
  return out.replace(/^[-.]+|[-.]+$/g, '')
}

export function estimateTokens(text) {
  const s = String(text == null ? '' : text)
  if (!s) return 0
  const cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const rest = s.length - cjk
  return Math.round(cjk / 1.7 + rest / 3.9)
}

export function scanSecrets(text) {
  const s = String(text == null ? '' : text)
  const hits = []
  if (/\bsk-[A-Za-z0-9_-]{12,}/.test(s)) hits.push('疑似 API key（sk-…）')
  if (/(password|passwd|pwd)\s*[:=]\s*\S/i.test(s)) hits.push('疑似口令（password=…）')
  if (/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(s)) hits.push('疑似内网地址')
  if (/\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(s)) hits.push('疑似内网地址')
  if (/\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/.test(s)) hits.push('疑似内网地址')
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) hits.push('疑似私钥')
  return hits
}

export function nextStageNumber(dir) {
  let max = 0
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return 1
  }
  for (const entry of names) {
    const m = /阶段-(\d+)/.exec(entry)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function stampText(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}`
  )
}

function localText(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

function warn(ctx, error) {
  const message = error && error.stack ? error.stack : String(error)
  try {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[dossier] ${message}`)
    else console.warn(`[dossier] ${message}`)
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- 持久化层 */

function emptyStore() {
  return { schema: 1, folders: [], entries: [], handoffs: {}, settings: {} }
}

function normalizeStore(raw) {
  const out = emptyStore()
  if (!raw || typeof raw !== 'object') return out

  if (Array.isArray(raw.folders)) {
    for (const folder of raw.folders) {
      if (!folder || typeof folder.id !== 'string' || typeof folder.name !== 'string') continue
      const id = folder.id.trim()
      const name = folder.name.trim().slice(0, 60)
      if (!id || !name) continue
      if (out.folders.some((f) => f.id === id)) continue
      out.folders.push({
        id,
        name,
        createdAt: num(folder.createdAt, Date.now()),
        sort: FOLDER_SORTS.has(folder.sort) ? folder.sort : 'manual',
        order: num(folder.order, out.folders.length + 1),
        pinned: folder.pinned === true,
      })
    }
    /* 卷宗自身也有顺序（默认顺序），归一化后重新编号 1..n */
    out.folders.sort((a, b) => a.order - b.order)
    out.folders.forEach((folder, index) => {
      folder.order = index + 1
    })
  }

  const knownFolder = new Set(out.folders.map((f) => f.id))
  const seen = new Set()
  if (Array.isArray(raw.entries)) {
    for (const entry of raw.entries) {
      if (!entry || typeof entry.sessionId !== 'string') continue
      const sessionId = entry.sessionId.trim()
      if (!sessionId || seen.has(sessionId)) continue
      if (!knownFolder.has(entry.folderId)) continue
      seen.add(sessionId)
      out.entries.push({
        sessionId,
        folderId: entry.folderId,
        order: num(entry.order, 0),
        pinned: entry.pinned === true,
        addedAt: num(entry.addedAt, Date.now()),
      })
    }
  }

  if (raw.handoffs && typeof raw.handoffs === 'object') {
    for (const [sessionId, value] of Object.entries(raw.handoffs)) {
      if (!value || typeof value !== 'object') continue
      out.handoffs[sessionId] = {
        path: String(value.path || ''),
        backup: String(value.backup || ''),
        stage: num(value.stage, 0),
        at: num(value.at, 0),
        /* 这条对话一共交接了几次：老存储里没有这个字段，按 1 次算 */
        count: Math.max(1, Math.floor(num(value.count, 1))),
        /* 导入时记下「导出时它在哪个卷宗」：换机器后对话不在本地，靠它认回卷宗 */
        folderName: String(value.folderName || ''),
        /* 从交接包导入的：对话可能不在本机，允许按 folderName 归组 */
        imported: value.imported === true,
      }
    }
  }

  if (raw.settings && typeof raw.settings === 'object') out.settings = { ...raw.settings }
  return out
}

function loadStore() {
  try {
    return normalizeStore(JSON.parse(readFileSync(STORE_PATH, 'utf8')))
  } catch {
    return emptyStore()
  }
}

function saveStore(store) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  const temp = `${STORE_PATH}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  if (existsSync(STORE_PATH)) {
    try {
      copyFileSync(STORE_PATH, `${STORE_PATH}.bak`)
    } catch {
      /* 备份失败不影响主写入 */
    }
  }
  renameSync(temp, STORE_PATH)
}

/* ------------------------------------------------------------ 会话元数据 */

// Cordis 里直接读一个没声明注入的服务会抛
// 「cannot get property "x" without inject」，所以一律走可选访问
function service(ctx, name) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
    return ctx[name]
  } catch {
    return undefined
  }
}

function sessionHeader(ctx, sessionId) {
  try {
    const sessions = service(ctx, 'sessions')
    if (!sessions || typeof sessions.get !== 'function' || !sessionId) return undefined
    const session = sessions.get(sessionId)
    return session && session.header ? session.header : undefined
  } catch {
    return undefined
  }
}

// 会话工作目录：先看内存里的 session header（只对热会话有效），
// 再看工作区注册表（冷会话也能命中），最后才是部署兜底目录。
function sessionCwd(ctx, sessionId) {
  const header = sessionHeader(ctx, sessionId)
  if (header && typeof header.cwd === 'string' && header.cwd) return header.cwd

  const id = String(sessionId || '')
  if (id) {
    try {
      const registry = service(ctx, 'workspaceRegistry')
      const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        const ids = workspace && Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
        if (ids.includes(id) && typeof workspace.path === 'string' && workspace.path) return workspace.path
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const wd = service(ctx, 'workingDirectory')
    if (wd && typeof wd === 'string') return wd
    if (wd && typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) return wd.defaultDirectory
    if (wd && typeof wd.get === 'function') {
      const value = wd.get()
      if (typeof value === 'string' && value) return value
      if (value && typeof value.cwd === 'string' && value.cwd) return value.cwd
      if (value && typeof value.path === 'string' && value.path) return value.path
    }
  } catch {
    /* ignore */
  }

  const fallback = process.cwd()
  return fallback && fallback !== '/' ? fallback : homedir()
}

/*
 * 一条对话「有没有东西可交接」：只看真实回合，不把会话自身的元事件算进来。
 * 新建对话立刻点交接，只会花一次冷启动的钱写出一份空话，所以在投递前就拦掉。
 */
function sessionHasWork(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || !event.type) continue
    const type = event.type
    if (type === 'user/message' || type === 'assistant/message') return true
    if (type === 'turn/end' || type === 'step/start') return true
  }
  return false
}

/* 返回拒绝理由；空串表示可以交接。读不到会话状态就放行，不误伤。 */
async function handoffRefusal(ctx, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return ''

  const sessions = service(ctx, 'sessions')
  let session
  try {
    session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
  } catch {
    session = undefined
  }
  if (session) {
    let events = []
    try {
      events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
    } catch {
      events = []
    }
    return sessionHasWork(events) ? '' : EMPTY_SESSION_MESSAGE
  }

  // 冷会话不在内存里：日志还在盘上，读一遍再判断。
  try {
    const persistence = service(ctx, 'sessionPersistence')
    if (persistence && typeof persistence.open === 'function') {
      const handle = await persistence.open(id, 'read')
      const result = await handle.read()
      return sessionHasWork(result && result.events) ? '' : EMPTY_SESSION_MESSAGE
    }
  } catch {
    /* 读不到就不拦：宁可放行，也不能把能交接的对话挡在外面 */
  }
  return ''
}

function resolveRoot(cwd, requested) {
  const value = String(requested || '').trim()
  if (!value) return join(cwd, DEFAULTS.handoffRoot)
  return isAbsolute(value) ? value : join(cwd, value)
}

function workspaceSlug(cwd) {
  return slugify(String(cwd || '').replace(/[\\/]+/g, '-').replace(/^[A-Za-z]:-/, ''), 40) || 'unknown'
}

/* ------------------------------------------------------------------- 状态 */

function stateOf(ctx, conf, sessionId) {
  const store = loadStore()
  const cwd = sessionCwd(ctx, sessionId)
  return {
    ok: true,
    schema: 1,
    folders: store.folders,
    entries: store.entries.slice().sort((a, b) => a.order - b.order),
    handoffs: store.handoffs,
    settings: { maxHandoffTokens: conf.maxHandoffTokens, ...store.settings },
    paths: {
      cwd,
      handoffRoot: resolveRoot(cwd, conf.handoffRoot),
      backupRoot: BACKUP_ROOT,
      store: STORE_PATH,
    },
  }
}

/* --------------------------------------------------------------- 写操作 */

function applyOp(ctx, conf, payload) {
  const store = loadStore()
  const op = String((payload && payload.op) || '')
  const now = Date.now()

  switch (op) {
    case 'folder.create': {
      const folderName = String(payload.name || '').trim().slice(0, 60)
      if (!folderName) throw new Error('卷宗名不能为空')
      if (store.folders.some((f) => f.name === folderName)) throw new Error(`已有同名卷宗：${folderName}`)
      if (store.folders.length >= 200) throw new Error('卷宗数量已达上限')
      store.folders.push({
        id: `f_${randomUUID().slice(0, 8)}`,
        name: folderName,
        createdAt: now,
        sort: 'manual',
        order: store.folders.length + 1,
      })
      break
    }
    case 'folder.move': {
      const id = String(payload.id || '')
      const delta = payload.delta === -1 || payload.delta === 'up' ? -1 : 1
      const list = store.folders.slice().sort((a, b) => a.order - b.order)
      const index = list.findIndex((f) => f.id === id)
      if (index < 0) throw new Error('卷宗不存在')
      const target = index + delta
      if (target < 0 || target >= list.length) break
      const [moved] = list.splice(index, 1)
      list.splice(target, 0, moved)
      list.forEach((folder, i) => {
        folder.order = i + 1
      })
      break
    }
    case 'folder.rename': {
      const folder = store.folders.find((f) => f.id === payload.id)
      if (!folder) throw new Error('卷宗不存在')
      const folderName = String(payload.name || '').trim().slice(0, 60)
      if (!folderName) throw new Error('卷宗名不能为空')
      if (store.folders.some((f) => f.id !== folder.id && f.name === folderName)) {
        throw new Error(`已有同名卷宗：${folderName}`)
      }
      folder.name = folderName
      break
    }
    case 'folder.sort': {
      const folder = store.folders.find((f) => f.id === payload.id)
      if (!folder) throw new Error('卷宗不存在')
      folder.sort = FOLDER_SORTS.has(payload.sort) ? payload.sort : 'manual'
      break
    }
    case 'folder.pin': {
      const folder = store.folders.find((f) => f.id === payload.id)
      if (!folder) throw new Error('卷宗不存在')
      folder.pinned = payload.pinned !== false
      break
    }
    case 'folder.remove': {
      const index = store.folders.findIndex((f) => f.id === payload.id)
      if (index < 0) throw new Error('卷宗不存在')
      store.folders.splice(index, 1)
      store.entries = store.entries.filter((e) => e.folderId !== payload.id)
      break
    }
    case 'entry.assign': {
      const sessionId = String(payload.sessionId || '').trim()
      if (!sessionId) throw new Error('缺少 sessionId')
      const folderId = payload.folderId == null ? null : String(payload.folderId)
      store.entries = store.entries.filter((e) => e.sessionId !== sessionId)
      if (folderId) {
        const folder = store.folders.find((f) => f.id === folderId)
        if (!folder) throw new Error('卷宗不存在')
        const max = store.entries
          .filter((e) => e.folderId === folderId)
          .reduce((acc, e) => Math.max(acc, e.order), 0)
        store.entries.push({ sessionId, folderId, order: max + 1, pinned: false, addedAt: now })
      }
      break
    }
    case 'entry.pin': {
      const sessionId = String(payload.sessionId || '')
      const entry = store.entries.find((e) => e.sessionId === sessionId)
      if (!entry) throw new Error('该对话不在任何卷宗里')
      entry.pinned = payload.pinned !== false
      break
    }
    case 'entry.move': {
      const sessionId = String(payload.sessionId || '')
      const delta = payload.delta === -1 || payload.delta === 'up' ? -1 : 1
      const current = store.entries.find((e) => e.sessionId === sessionId)
      if (!current) throw new Error('该对话不在任何卷宗里')
      /* 只在同一组里挪：置顶的与未置顶的不混排 */
      const siblings = store.entries
        .filter((e) => e.folderId === current.folderId && Boolean(e.pinned) === Boolean(current.pinned))
        .sort((a, b) => a.order - b.order)
      const index = siblings.indexOf(current)
      const target = index + delta
      if (target < 0 || target >= siblings.length) break
      siblings.splice(index, 1)
      siblings.splice(target, 0, current)
      siblings.forEach((entry, i) => {
        entry.order = i + 1
      })
      break
    }
    case 'settings.update': {
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
      store.settings = { ...store.settings, ...patch }
      break
    }
    default:
      throw new Error(`未知操作：${op}`)
  }

  saveStore(store)
  if (op === 'folder.create' || op === 'folder.rename') ensureHandoffTree(ctx, conf, payload.viewSessionId)
  return stateOf(ctx, conf, payload.viewSessionId)
}

/* ------------------------------------------------------- 交接文档目录视图 */

function fileInfo(path, name, sessionId) {
  let size = 0
  let mtime = 0
  try {
    const info = statSync(path)
    size = info.size
    mtime = info.mtimeMs
  } catch {
    /* 读不到就当空文件 */
  }
  return { name, path, size, mtime, sessionId: sessionId || '' }
}

function markdownFiles(dir, sidByPath) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => {
        const full = join(dir, entry.name)
        return fileInfo(full, entry.name, sidByPath ? sidByPath.get(full) : '')
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

// 每个卷宗对应交接目录下的一个同名子文件夹；没有卷宗的文档直接放在主文件夹里。
function ensureHandoffTree(ctx, conf, sessionId) {
  const store = loadStore()
  const cwd = sessionCwd(ctx, sessionId)
  const root = resolveRoot(cwd, conf.handoffRoot)
  try {
    mkdirSync(root, { recursive: true })
    for (const folder of store.folders) {
      const name = slugify(folder.name, 40)
      if (name) mkdirSync(join(root, name), { recursive: true })
    }
  } catch (error) {
    warn(ctx, error)
  }
  return { store, root }
}

function docsOf(ctx, conf, sessionId) {
  const { store, root } = ensureHandoffTree(ctx, conf, sessionId)
  const folderBySlug = new Map()
  const folderById = new Map()
  const folderByName = new Map()
  for (const folder of store.folders) {
    folderBySlug.set(slugify(folder.name, 40), folder)
    folderById.set(folder.id, folder)
    folderByName.set(folder.name, folder)
  }

  // 文档 → 生成它的会话：用于「定位」，也用于判断这份文档现在该归哪个卷宗。
  const sidByPath = new Map()
  const folderNameOfSession = new Map()
  for (const [sid, value] of Object.entries(store.handoffs || {})) {
    if (value && value.path) sidByPath.set(resolve(value.path), sid)
    /* 只有「从交接包导入的」才按卷宗名认回去：本机自己移出卷宗的文档必须回未归档 */
    if (value && value.folderName && value.imported) folderNameOfSession.set(sid, String(value.folderName))
  }
  /* 归属跟着对话走：文档挂在哪个卷宗，由「生成它的对话现在在哪个卷宗」决定，
     跟它躺在盘上的哪个目录无关。挪对话不用搬文件，旧目录也不会再冒出来。 */
  const folderIdOfSession = new Map()
  for (const entry of store.entries || []) folderIdOfSession.set(entry.sessionId, entry.folderId)

  // 盘上所有的 .md（含子目录里的），先全部收上来再决定归组
  const allFiles = []
  const walk = (dir, dirName) => {
    let list = []
    try {
      list = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of list) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), entry.name)
        continue
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const full = join(dir, entry.name)
      allFiles.push({ ...fileInfo(full, entry.name, sidByPath.get(resolve(full))), dirName })
    }
  }
  walk(root, '')

  const filesByFolder = new Map()
  for (const folder of store.folders) filesByFolder.set(folder.id, [])
  const loose = []

  for (const file of allFiles) {
    const { dirName, ...info } = file
    if (info.sessionId) {
      const folderId = folderIdOfSession.get(info.sessionId)
      if (folderId && folderById.has(folderId)) {
        filesByFolder.get(folderId).push(info)
        continue
      }
      /* 生成它的对话已经不在任何卷宗里（被移出或已删除）：先看导入时记下的卷宗名，
         同名的卷宗还在就认回去（换机器导入的场景），否则收进「未归档」 */
      const fallbackName = folderNameOfSession.get(info.sessionId)
      const named = fallbackName ? folderByName.get(fallbackName) : undefined
      if (named) {
        filesByFolder.get(named.id).push(info)
        continue
      }
      loose.push({ ...info, origin: dirName || '' })
      continue
    }
    /* 不是插件写的文档（手放的或导入的）：只能按它所在的目录归 */
    const dirFolder = dirName ? folderBySlug.get(dirName) : undefined
    if (dirFolder && folderById.has(dirFolder.id)) filesByFolder.get(dirFolder.id).push(info)
    else loose.push({ ...info, origin: dirName || '' })
  }

  const folders = store.folders.map((folder) => {
    const files = (filesByFolder.get(folder.id) || []).sort((a, b) => b.mtime - a.mtime)
    return {
      key: slugify(folder.name, 40),
      folderId: folder.id,
      name: folder.name,
      known: true,
      files,
      latestAt: files.length ? files[0].mtime : 0,
    }
  })

  /* 有交接文档的文件夹按最新一份的时间从新到旧；还没文档的按名称排在后面 */
  folders.sort((a, b) => {
    const aHas = a.files.length > 0
    const bHas = b.files.length > 0
    if (aHas !== bHas) return aHas ? -1 : 1
    if (aHas && b.latestAt !== a.latestAt) return b.latestAt - a.latestAt
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  })
  loose.sort((a, b) => b.mtime - a.mtime)

  const total = loose.length + folders.reduce((sum, folder) => sum + folder.files.length, 0)
  return { ok: true, root, folders, loose, total }
}

/* ------------------------------------------------- 交接文档的导出 / 删除 */

function uniquePath(dir, name) {
  let candidate = join(dir, name)
  if (!existsSync(candidate)) return candidate
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let index = 2; index < 1000; index += 1) {
    candidate = join(dir, `${base}-${index}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${base}-${Date.now()}${ext}`)
}

/* 单份文档超过这个长度就不进交接包：交接包是给人换机器用的，不是备份大文件用的 */
const BUNDLE_FILE_LIMIT = 4 * 1024 * 1024

// 交接包里的一层目录就是卷宗名；主文件夹里的文档 folder 记空串。
// sessionId / stage 一起带走：换机器导入时才认得出「这份是谁的交接」，也才能把定位接回去。
function collectBundle(root, sidByPath, folderOfSession) {
  const files = []
  const walk = (dir, folder) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), entry.name)
        continue
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      const full = join(dir, entry.name)
      try {
        const info = statSync(full)
        if (info.size > BUNDLE_FILE_LIMIT) continue
        const content = readFileSync(full, 'utf8')
        const sessionId = (sidByPath && sidByPath.get(resolve(full))) || sessionOfDoc(content)
        /* 卷宗名以「对话现在的归属」为准：卷宗改过名也不会把文档导到旧目录里去 */
        const owner = sessionId && folderOfSession ? folderOfSession.get(sessionId) : ''
        files.push({
          folder: owner || folder,
          name: entry.name,
          mtime: info.mtimeMs,
          sessionId,
          stage: stageOfName(entry.name),
          content,
        })
      } catch {
        /* 读不到就跳过这一份 */
      }
    }
  }
  walk(root, '')
  return files
}

/* 文档头里记着「- 会话：xxx」：老的交接文档没进 handoffs 时，靠它认回对话 */
function sessionOfDoc(content) {
  const match = /^-\s*会话：\s*(\S+)\s*$/m.exec(String(content || ''))
  return match ? match[1] : ''
}

/* 文件名 阶段-NN-标题.md 里的阶段号 */
function stageOfName(name) {
  const match = /阶段-(\d+)/.exec(String(name || ''))
  return match ? Number(match[1]) : 0
}

function localStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`
}

// 只允许操作交接目录里的文件：路径先解析再比较前缀，避免 ../ 或绝对路径越界。
function docOp(ctx, conf, payload) {
  const root = resolve(resolveRoot(sessionCwd(ctx, payload.viewSessionId), conf.handoffRoot))
  const inside = (path) => {
    const target = resolve(String(path || ''))
    return target === root || target.startsWith(root + sep)
  }
  const op = String(payload.op || '')

  /* 整包导出：把交接目录下所有文档打成一个 json，换机器时带走 */
  if (op === 'exportBundle') {
    const wanted = String(payload.targetDir || '').trim()
    if (!wanted) throw new Error('没有指定导出目录')
    const targetDir = resolve(wanted)
    mkdirSync(targetDir, { recursive: true })
    const store = loadStore()
    const sidByPath = new Map()
    for (const [sid, value] of Object.entries(store.handoffs || {})) {
      if (value && value.path) sidByPath.set(resolve(value.path), sid)
    }
    const folderOfSession = new Map()
    for (const entry of store.entries || []) {
      const folder = store.folders.find((item) => item.id === entry.folderId)
      if (folder) folderOfSession.set(entry.sessionId, folder.name)
    }
    for (const [sid, value] of Object.entries(store.handoffs || {})) {
      if (value && value.folderName && !folderOfSession.has(sid)) folderOfSession.set(sid, String(value.folderName))
    }
    const files = collectBundle(root, sidByPath, folderOfSession)
    if (!files.length) throw new Error('交接目录里还没有文档')
    const bundle = {
      schema: 1,
      kind: 'dossier-handoff',
      exportedAt: new Date().toISOString(),
      files,
    }
    const to = uniquePath(targetDir, `dossier-handoff-${localStamp(new Date())}.json`)
    writeFileSync(to, JSON.stringify(bundle), 'utf8')
    return { ok: true, op, root, targetDir, file: to, count: files.length, done: [], failed: [] }
  }

  /* 整包导入：同名同内容跳过，同名不同内容另存为 -2、-3，绝不覆盖 */
  if (op === 'importBundle') {
    const bundle = payload.bundle
    if (!bundle || bundle.schema !== 1 || !Array.isArray(bundle.files)) {
      throw new Error('不是卷宗导出的交接包')
    }
    mkdirSync(root, { recursive: true })
    const done = []
    const failed = []
    for (const item of bundle.files) {
      try {
        const name = basename(String((item && item.name) || ''))
        if (!name || !/\.md$/i.test(name)) {
          failed.push({ path: String((item && item.name) || ''), error: '不是 .md 文档' })
          continue
        }
        const folder = slugify(String((item && item.folder) || ''), 40)
        const dir = folder ? join(root, folder) : root
        mkdirSync(dir, { recursive: true })
        const content = String((item && item.content) || '')
        const trace = {
          sessionId: String((item && item.sessionId) || '') || sessionOfDoc(content),
          stage: num(item && item.stage, stageOfName(name)),
          at: num(item && item.at, num(item && item.mtime, Date.now())),
          folderName: String((item && item.folder) || ''),
        }
        const same = join(dir, name)
        if (existsSync(same) && readFileSync(same, 'utf8') === content) {
          done.push({ from: name, to: same, skipped: true, ...trace })
          continue
        }
        const to = uniquePath(dir, name)
        writeFileSync(to, content, 'utf8')
        done.push({ from: name, to, ...trace })
      } catch (error) {
        failed.push({ path: String((item && item.name) || ''), error: String((error && error.message) || error) })
      }
    }
    /* 把「这份文档是谁的交接」也接回来：同机导入能重新定位到对话，
       换机器时对话不在，就留 folderName 让面板按导出时的卷宗认回去 */
    const store = loadStore()
    let restored = 0
    /* 一条对话可能有好几份文档：按阶段取最大的那份额作为「定位」的目标 */
    const best = new Map()
    for (const item of done) {
      if (!item.sessionId) continue
      const stage = Math.max(1, item.stage || stageOfName(item.from))
      const prevBest = best.get(item.sessionId)
      if (!prevBest || stage > prevBest.stage) best.set(item.sessionId, { ...item, stage })
    }
    for (const [sessionId, item] of best) {
      const prev = store.handoffs[sessionId]
      /* 本机原本就有这条对话的交接文档（指针还活着）：别把「定位」抢到导入的副本上 */
      if (prev && prev.path && existsSync(prev.path)) continue
      store.handoffs[sessionId] = {
        path: item.to,
        backup: prev && prev.backup ? prev.backup : '',
        stage: item.stage,
        at: item.at || Date.now(),
        count: Math.max(1, Math.floor(num(prev && prev.count, 0)) + 1),
        folderName: item.folderName || (prev && prev.folderName) || '',
        imported: true,
      }
      restored += 1
    }
    if (restored) saveStore(store)
    return { ok: true, op, root, targetDir: '', done, failed, restored }
  }

  const raw = Array.isArray(payload.files) ? payload.files : [payload.files]
  const files = raw.filter(Boolean).map(String)
  if (!files.length) throw new Error('没有选中文件')

  let targetDir = ''
  if (op === 'export') {
    const wanted = String(payload.targetDir || '').trim()
    if (!wanted) throw new Error('没有指定导出目录')
    targetDir = resolve(wanted)
    mkdirSync(targetDir, { recursive: true })
  } else if (op !== 'delete') {
    throw new Error(`未知操作：${op}`)
  }

  const done = []
  const failed = []
  for (const file of files) {
    if (!inside(file)) {
      failed.push({ path: file, error: '不在交接文档目录里' })
      continue
    }
    try {
      if (!existsSync(file)) {
        failed.push({ path: file, error: '文件已经不在了' })
        continue
      }
      if (op === 'delete') {
        unlinkSync(file)
        done.push({ from: file, to: '' })
      } else {
        const to = uniquePath(targetDir, basename(file))
        copyFileSync(file, to)
        done.push({ from: file, to })
      }
    } catch (error) {
      failed.push({ path: file, error: String((error && error.message) || error) })
    }
  }
  return { ok: true, op, root, targetDir, done, failed }
}

/* ---------------------------------------------------------- 交接文档落盘 */

function renderDoc({ title, body, sessionId, folderName, stage, date }) {
  const head = [
    `# ${title}`,
    '',
    `- 卷宗：${folderName || '未归档'}`,
    `- 阶段：${pad2(stage)}`,
    `- 生成：${localText(date)}`,
    `- 会话：${sessionId}`,
    '',
    '> 给接手的人：这是状态快照，不是过程记录。先读「下一步」与「已否决的方案」再动手。',
    '',
    '',
  ].join('\n')
  return `${head}${String(body || '').trim()}\n`
}

function recordHandoff(store, sessionId, value) {
  store.handoffs = store.handoffs || {}
  store.handoffs[sessionId] = value
  saveStore(store)
}

function writeHandoff(ctx, conf, { sessionId, title, body, goal }) {
  const sid = String(sessionId || '').trim()
  if (!sid) throw new Error('缺少会话 id，无法定位交接文档位置')
  const bodyText = String(body || '').trim()
  if (!bodyText) throw new Error('body 为空：把完整正文传进来')
  if (bodyText.length > MAX_BODY_CHARS) throw new Error('body 过长（超过 40 万字符）')

  const store = loadStore()
  const entry = store.entries.find((e) => e.sessionId === sid)
  const folder = entry ? store.folders.find((f) => f.id === entry.folderId) : undefined

  const cwd = sessionCwd(ctx, sid)
  const root = resolveRoot(cwd, conf.handoffRoot)
  // 有卷宗就进同名子文件夹；没有卷宗的直接放在主文件夹里，和面板上的「交接文档」一一对应。
  const goalName = slugify(String(goal || (folder && folder.name) || '').trim(), 40)
  const dir = goalName ? join(root, goalName) : root
  mkdirSync(dir, { recursive: true })

  const stage = nextStageNumber(dir)
  const date = new Date()
  const titleClean = String(title || '').trim().slice(0, 80) || goalName || '交接文档'
  const titleSlug = slugify(titleClean, 20)
  const fileName = `阶段-${pad2(stage)}${titleSlug ? `-${titleSlug}` : ''}.md`
  const target = join(dir, fileName)
  const doc = renderDoc({ title: titleClean, body: bodyText, sessionId: sid, folderName: folder && folder.name, stage, date })
  writeFileSync(target, doc, 'utf8')

  let backup = ''
  try {
    const backupDir = join(BACKUP_ROOT, workspaceSlug(cwd))
    mkdirSync(backupDir, { recursive: true })
    backup = join(backupDir, `${stampText(date)}-${sid.replace(/^session-/, '').slice(0, 8)}-${fileName}`)
    copyFileSync(target, backup)
  } catch (error) {
    warn(ctx, error)
    backup = ''
  }

  /* 这条对话一共交接了几次：跟它落在哪个卷宗无关，只看它自己的记录 */
  const previous = store.handoffs && store.handoffs[sid] ? store.handoffs[sid] : null
  const count = previous ? Math.max(1, Math.floor(num(previous.count, 1))) + 1 : 1
  recordHandoff(store, sid, {
    path: target,
    backup,
    stage,
    at: date.getTime(),
    count,
    /* 记下这次落在哪个卷宗：换机器导入时，对话不在也能按名字认回卷宗 */
    folderName: folder ? folder.name : '',
  })

  const tokens = estimateTokens(doc)
  const warnings = scanSecrets(doc)
  if (tokens > conf.maxHandoffTokens) {
    warnings.unshift(`篇幅偏长（约 ${tokens} token，上限 ${conf.maxHandoffTokens}）：先砍「过程」「背景」`)
  }
  return { ok: true, path: target, backup, stage, count, tokens, warnings }
}

/* ------------------------------------------------------------------ HTTP */

function isLocalRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  if (!address) return true
  return LOOPBACK.has(address) || address.startsWith('::ffff:127.')
}

function readJsonBody(req, limit = 1_048_576) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('请求体过大'))
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolveBody({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolveBody(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

/* ------------------------------------------------------- 用量与费用估算 */

// deepseek-flash 价格（元 / 百万 token）。命中缓存与未命中差 50 倍，
// 所以真正贵的是冷启动时把整段上下文重算一遍。
const PRICING = {
  idle: { miss: 1, hit: 0.02, out: 4 },
  peak: { miss: 2, hit: 0.04, out: 8 },
}

function priceBand(date) {
  const hour = (date instanceof Date ? date : new Date()).getHours()
  const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  return peak ? 'peak' : 'idle'
}

// usage.inputTokens 是「未命中」的那部分，cacheReadTokens 是「命中」的那部分，
// 两者相加才是这次请求真正喂进去的上下文长度（对照 09:09 那次：716,319 + 22,400 ≈ 74 万）。
function estimateCost(usage, band) {
  const price = PRICING[band === 'peak' ? 'peak' : 'idle']
  const miss = Number(usage && usage.inputTokens) || 0
  const hit = Number(usage && usage.cacheReadTokens) || 0
  const output = Number(usage && usage.outputTokens) || 0
  const cost = (miss * price.miss + hit * price.hit + output * price.out) / 1_000_000
  return { cost, miss, hit, total: miss + hit, output, band: band === 'peak' ? 'peak' : 'idle' }
}

// 只对「活着」的会话有数：冷会话的日志没有载入内存，不去读盘。
function usageOf(ctx, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return { ok: true, live: false }
  const sessions = service(ctx, 'sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(id) : undefined
  if (!session) return { ok: true, live: false }

  let turns = 0
  let last = null
  let seen = 0
  let lastAt = 0
  let lastEventAt = 0
  const turnNumbers = new Set()
  let turnEnds = 0
  let steps = 0
  let userMessages = 0
  try {
    const events = typeof session.ownEvents === 'function' ? session.ownEvents() : []
    seen = events.length
    for (const event of events) {
      if (!event || !event.type) continue
      const when = Number(event.time) || 0
      if (when > lastEventAt) lastEventAt = when
      if (event.type === 'turn/end') turnEnds += 1
      else if (event.type === 'step/start') steps += 1
      else if (event.type === 'user/message') userMessages += 1
      else if (event.type === 'assistant/message' && event.data) {
        if (event.data.turn !== undefined && event.data.turn !== null) turnNumbers.add(event.data.turn)
        if (event.data.usage) {
          last = event.data.usage
          lastAt = Number(event.time) || 0
        }
      }
    }
  } catch {
    /* 读事件失败就当没有 */
  }
  turns = Math.max(turnEnds, turnNumbers.size)

  let contextTokens = 0
  let contextWindow = 0
  try {
    const projections = service(ctx, 'sessionProjections')
    if (projections && typeof projections.snapshot === 'function') {
      const values = projections.snapshot(session, ['contextPressure'])
      const pressure = values && values.contextPressure
      contextTokens = Number(pressure && (pressure.projectedTokens ?? pressure.pressureTokens)) || 0
      contextWindow = Number(pressure && pressure.contextWindow) || 0
    }
  } catch {
    /* 投影不可用就留 0 */
  }

  const estimate = last ? estimateCost(last, priceBand(new Date(lastAt || Date.now()))) : null
  const lastInput = last ? Number(last.inputTokens) || 0 : 0
  const lastCacheRead = last ? Number(last.cacheReadTokens) || 0 : 0
  return {
    ok: true,
    live: true,
    turns,
    steps,
    userMessages,
    events: seen,
    // 投影要等这一进程跑过一次请求才有值；没有就用「上一次请求的输入长度」当上下文大小
    contextTokens: contextTokens || lastInput + lastCacheRead,
    contextWindow,
    lastInput,
    lastOutput: last ? Number(last.outputTokens) || 0 : 0,
    lastCacheRead,
    lastTotal: lastInput + lastCacheRead,
    lastHitRate: lastInput + lastCacheRead ? Math.round((lastCacheRead / (lastInput + lastCacheRead)) * 100) : 0,
    lastCost: estimate ? Math.round(estimate.cost * 10000) / 10000 : null,
    band: estimate ? estimate.band : priceBand(new Date()),
    lastAt,
    at: lastEventAt || lastAt,
  }
}

/*
 * 冷会话（不在内存里）的用量：日志还在磁盘上，走 sessionPersistence 读一遍，
 * 不用自己解 zstd。只在面板选中某条对话时按需调用，不参与列表批量渲染。
 */
async function usageOfCold(ctx, sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return null
  const persistence = service(ctx, 'sessionPersistence')
  if (!persistence || typeof persistence.open !== 'function') return null

  let handle = null
  try {
    handle = await persistence.open(id, 'read')
    const result = await handle.read()
    const events = (result && result.events) || []
    if (!events.length) return null

    let last = null
    let lastAt = 0
    let lastEventAt = 0
    let steps = 0
    let userMessages = 0
    for (const event of events) {
      if (!event || !event.type) continue
      const when = Number(event.time) || 0
      if (when > lastEventAt) lastEventAt = when
      if (event.type === 'step/start') steps += 1
      else if (event.type === 'user/message') userMessages += 1
      else if (event.type === 'assistant/message' && event.data && event.data.usage) {
        last = event.data.usage
        lastAt = when
      }
    }
    if (!last) return null

    const estimate = estimateCost(last, priceBand(new Date(lastAt || Date.now())))
    const lastInput = Number(last.inputTokens) || 0
    const lastCacheRead = Number(last.cacheReadTokens) || 0
    const total = lastInput + lastCacheRead
    return {
      ok: true,
      live: false,
      cold: true,
      turns: 0,
      steps,
      userMessages,
      events: events.length,
      contextTokens: total,
      contextWindow: 0,
      lastInput,
      lastOutput: Number(last.outputTokens) || 0,
      lastCacheRead,
      lastTotal: total,
      lastHitRate: total ? Math.round((lastCacheRead / total) * 100) : 0,
      lastCost: Math.round(estimate.cost * 10000) / 10000,
      band: estimate.band,
      lastAt,
      at: lastEventAt || lastAt,
    }
  } catch {
    return null
  } finally {
    try {
      if (handle) await handle.close()
    } catch {
      /* 关不掉就算了 */
    }
  }
}

function registerRoutes(ctx, conf, webServer) {
  const disposers = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        try {
          const url = new URL(req.url || STATE_PATH, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || ''
          return sendJson(res, 200, stateOf(ctx, conf, sessionId))
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: USAGE_PATH,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        try {
          const url = new URL(req.url || USAGE_PATH, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || ''
          const live = usageOf(ctx, sessionId)
          if (live && live.live) return sendJson(res, 200, live)
          const cold = await usageOfCold(ctx, sessionId)
          return sendJson(res, 200, cold || live)
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: DOCS_PATH,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        try {
          const url = new URL(req.url || DOCS_PATH, 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || ''
          return sendJson(res, 200, docsOf(ctx, conf, sessionId))
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: DOC_OP_PATH,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        try {
          const payload = await readJsonBody(req)
          return sendJson(res, 200, docOp(ctx, conf, payload))
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: OP_PATH,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        try {
          const payload = await readJsonBody(req)
          return sendJson(res, 200, applyOp(ctx, conf, payload))
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: HANDOFF_PATH,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })
        try {
          const payload = await readJsonBody(req)
          const sessionId = String(payload.sessionId || '').trim()
          if (!sessionId) throw new Error('缺少 sessionId')
          const refusal = await handoffRefusal(ctx, sessionId)
          if (refusal) {
            return sendJson(res, 409, { ok: false, error: refusal, code: 'empty-session' })
          }
          const controller = service(ctx, 'sessionController')
          if (!controller || typeof controller.prompt !== 'function') {
            throw new Error('会话控制器不可用：无法把交接请求投递进该对话')
          }
          const controllerSignal = new AbortController()
          const prompt = String(payload.prompt || conf.handoffPrompt)
          const requestId = `dossier-${randomUUID()}`
          await controller.prompt(
            {
              requestId,
              sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: prompt }],
            },
            controllerSignal.signal,
          )
          return sendJson(res, 200, { ok: true, requestId })
        } catch (error) {
          const code = error && error.code ? String(error.code) : ''
          return sendJson(res, 400, {
            ok: false,
            error: String((error && error.message) || error),
            code,
          })
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------ 工具 */

const TOOL_DESCRIPTION = [
  '把当前会话的「交接文档」写入工作区的交接目录，并自动复制一份到 ~/.dsh 的卷宗备份目录。',
  '',
  '唯一目的：让一个没有上下文的新会话，不读旧对话也能接着做。写状态，不写故事。',
  '',
  'body 用下面的骨架（Markdown，从 ## 开始，不要写一级标题，缺项写「无」）：',
  '## 目标 —— 一句话：这件事要达成什么',
  '## 当前状态 —— 已完成/进行中，各一句，带证据（文件路径、命令、数字）',
  '## 关键决策 —— 决策 → 理由，一条一行',
  '## 已否决的方案 —— 方案 → 为什么否决（最容易遗漏，也最贵；没有写「无」）',
  '## 约束 —— 版本、不能改的东西、用户明确要求',
  '## 涉及文件 —— 路径 + 一句话作用，不贴代码',
  '## 下一步 —— 按顺序、可执行、含验收标准',
  '## 未解决与风险 —— 悬而未决的问题、已知坑',
  '',
  '硬规则：',
  '- 总长 ≤ 1500 token（约 2000 汉字）。超了先砍「过程」「背景」，保住「已否决」「下一步」「约束」。',
  '- 不贴代码块、不贴日志、不抄对话原文，只给路径与结论。',
  '- 「涉及文件」和正文里的路径都从工作区根写起（如 dsh-dossier/index.js），不要写要人猜的简写。',
  '- 「下一步」必须是下一个人能直接执行的动作，不是方向描述。',
  '- 不写寒暄，不写「本次会话中我们讨论了…」。',
  '- 会话里的密钥、口令、内网地址不要写进文档。',
  '',
  'title：一句话项目名，会变成文件名的一部分。',
].join('\n')

function registerTool(ctx, conf) {
  const tools = service(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    warn(ctx, 'tools 服务不可用，交接工具没有注册')
    return () => {}
  }
  const disposer = tools.register({
    name: 'dossier_handoff_write',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话项目名，例如「卷宗插件 v0.1」。' },
        body: { type: 'string', description: '从「## 目标」开始的完整正文（Markdown）。' },
        goal: { type: 'string', description: '可选：交接目录下的子目录名，默认用该会话所在卷宗的名字。' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          backup: { type: 'string' },
          stage: { type: 'number' },
          count: { type: 'number' },
          folderName: { type: 'string' },
          tokens: { type: 'number' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'path', 'tokens'],
        additionalProperties: false,
      },
      render(_args, value) {
        const v = value && typeof value === 'object' ? value : {}
        const lines = [`已写入：${v.path || '(未知路径)'}`]
        if (v.backup) lines.push(`备份：${v.backup}`)
        if (v.stage) lines.push(`阶段：${pad2(Number(v.stage) || 0)}`)
        if (v.tokens) lines.push(`篇幅：约 ${v.tokens} token`)
        if (Array.isArray(v.warnings) && v.warnings.length) {
          lines.push('', '提醒：')
          for (const item of v.warnings) lines.push(`- ${item}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
      const result = writeHandoff(ctx, conf, {
        sessionId,
        title: input.title,
        body: input.body,
        goal: input.goal,
      })
      /* 工具返回值要过 output.schema 校验：只回声明过的字段，别把内部记账字段带出去 */
      return {
        ok: result.ok,
        path: result.path,
        backup: result.backup,
        stage: result.stage,
        tokens: result.tokens,
        warnings: result.warnings,
      }
    },
  })
  return typeof disposer === 'function' ? disposer : undefined
}

/* ------------------------------------------------------------------ 装配 */

function mergeConfig(config) {
  const merged = { ...DEFAULTS }
  if (!config || typeof config !== 'object') return merged
  if (typeof config.handoffRoot === 'string' && config.handoffRoot.trim()) {
    merged.handoffRoot = config.handoffRoot.trim()
  }
  if (typeof config.handoffPrompt === 'string' && config.handoffPrompt.trim()) {
    merged.handoffPrompt = config.handoffPrompt.trim()
  }
  if (Number.isFinite(num(config.maxHandoffTokens, NaN))) {
    const value = num(config.maxHandoffTokens, merged.maxHandoffTokens)
    if (value >= 400 && value <= 20000) merged.maxHandoffTokens = value
  }
  return merged
}

function withService(ctx, dependencies, callback) {
  try {
    if (typeof ctx.inject !== 'function') return
    return ctx.inject(dependencies, (child) => {
      try {
        return callback(child)
      } catch (error) {
        warn(ctx, error)
        return undefined
      }
    })
  } catch (error) {
    warn(ctx, error)
    return undefined
  }
}

export function apply(ctx, config) {
  const conf = mergeConfig(config)

  withService(ctx, ['webServer'], (child) => registerRoutes(ctx, conf, child.webServer))
  // 注意：注入进来的服务挂在 child 上，用外层 ctx 取 tools 会是 undefined。
  withService(ctx, ['tools'], (child) => registerTool(child, conf))
}

export const __testing = {
  slugify,
  estimateTokens,
  scanSecrets,
  nextStageNumber,
  normalizeStore,
  renderDoc,
  pad2,
  stateOf,
  applyOp,
  writeHandoff,
  mergeConfig,
  loadStore,
  emptyStore,
  usageOf,
  usageOfCold,
  collectBundle,
  estimateCost,
  priceBand,
  PRICING,
  docsOf,
  ensureHandoffTree,
  docOp,
  uniquePath,
  sessionHasWork,
  handoffRefusal,
  EMPTY_SESSION_MESSAGE,
  STORE_PATH,
  BACKUP_ROOT,
}
