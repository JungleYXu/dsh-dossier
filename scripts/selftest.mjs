/**
 * 卷宗 selftest —— 不开浏览器、不连宿主，直接把宿主半边的纯逻辑跑一遍。
 *
 *   node scripts/selftest.mjs
 *
 * 覆盖：slugify / estimateTokens / scanSecrets / nextStageNumber / normalizeStore /
 *       renderDoc / applyOp（创建·归入·换卷·上下移·排序·删除）/ writeHandoff（写盘·备份·阶段递增）
 * 全部写入都在临时目录里进行（用 DSH_DOSSIER_STORE / DSH_DOSSIER_BACKUP 改道）。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dossier-selftest-'))
const storePath = join(root, 'dossier.json')
const backupRoot = join(root, 'backup')
const cwd = join(root, 'workspace')
mkdirSync(cwd, { recursive: true })

process.env.DSH_DOSSIER_STORE = storePath
process.env.DSH_DOSSIER_BACKUP = backupRoot

const { __testing } = await import('../index.js')
const {
  slugify,
  estimateTokens,
  scanSecrets,
  nextStageNumber,
  normalizeStore,
  renderDoc,
  stateOf,
  applyOp,
  writeHandoff,
  mergeConfig,
  usageOf,
  estimateCost,
  priceBand,
  docsOf,
  docOp,
  collectBundle,
  usageOfCold,
  STORE_PATH,
  BACKUP_ROOT,
} = __testing

/* ------------------------------------------------------------------ 断言器 */

let passed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail ? `${label} — ${detail}` : label)
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `期望 ${b}，实际 ${a}`)
}

const ctx = {
  sessions: { get: () => undefined },
  workingDirectory: { get: () => cwd },
  logger: { warn() {} },
}
const conf = mergeConfig({})

try {
  /* ------------------------------------------------------------- 1. 纯函数 */

  eq('路径改道生效', [STORE_PATH, BACKUP_ROOT], [storePath, backupRoot])

  /* 发进对话的那句话就是用户看到的那句：太长会把对话框画满，所以只留一句短话 */
  check('交接指令是一句短话', conf.handoffPrompt.length < 70, `${conf.handoffPrompt.length} 字：${conf.handoffPrompt}`)
  check('短话里点了工具名', conf.handoffPrompt.includes('dossier_handoff_write'), conf.handoffPrompt)
  check('短话里要求只回一句确认', conf.handoffPrompt.includes('只回一句确认'), conf.handoffPrompt)

  eq('slugify 保留中文', slugify('卷宗 面板/交接'), '卷宗-面板-交接')
  eq('slugify 去非法字符', slugify('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h')
  eq('slugify 空输入', slugify('   '), '')
  check('slugify 长度上限', Array.from(slugify('一二三四五六七八九十', 4)).length === 4, '应为 4 个字符')
  check('slugify 不以横杠开头结尾', !/^[-.]|[-.]$/.test(slugify('--a b--')), slugify('--a b--'))

  eq('estimateTokens 空串', estimateTokens(''), 0)
  const cjkTokens = estimateTokens('中'.repeat(170))
  check('estimateTokens 中文约 1.7 字/token', cjkTokens >= 95 && cjkTokens <= 105, `实际 ${cjkTokens}`)
  const asciiTokens = estimateTokens('a'.repeat(390))
  check('estimateTokens 英文约 3.9 字/token', asciiTokens >= 97 && asciiTokens <= 103, `实际 ${asciiTokens}`)

  eq('scanSecrets 干净文本', scanSecrets('这个函数返回布尔值，改在 src/main.js。'), [])
  eq('scanSecrets 命中 sk-', scanSecrets('key = sk-abcdefghijklmnopqrst').length, 1)
  eq('scanSecrets 命中 password', scanSecrets('password=hunter2').length, 1)
  eq('scanSecrets 命中内网', scanSecrets('连 192.168.31.7:8080').length, 1)
  eq('scanSecrets 命中私钥', scanSecrets('-----BEGIN RSA PRIVATE KEY-----').length, 1)
  eq('scanSecrets 不误报版本号', scanSecrets('升级到 10.2.0'), [])

  const stageDir = join(root, 'stage')
  eq('nextStageNumber 目录不存在', nextStageNumber(stageDir), 1)
  mkdirSync(stageDir, { recursive: true })
  writeFileSync(join(stageDir, '阶段-01-甲.md'), 'x')
  writeFileSync(join(stageDir, '阶段-03-乙.md'), 'x')
  writeFileSync(join(stageDir, '随手记.md'), 'x')
  eq('nextStageNumber 取最大+1', nextStageNumber(stageDir), 4)

  /* --------------------------------------------------------- 2. 存储校验 */

  const dirty = {
    folderOrder: [],
    folders: [
      { id: 'f1', name: '卷宗A', createdAt: 1, sort: 'time' },
      { id: 'f1', name: '重复 id', createdAt: 2 },
      { id: '', name: '空 id' },
      { id: 'f2', name: '  卷宗B  ', sort: '乱写' },
    ],
    entries: [
      { sessionId: 's1', folderId: 'f1', order: 2 },
      { sessionId: 's1', folderId: 'f2', order: 9 },
      { sessionId: 's2', folderId: '不存在', order: 1 },
      { sessionId: '', folderId: 'f1', order: 1 },
    ],
    handoffs: { s1: { path: '/a.md', stage: '3' }, bad: null },
  }
  const clean = normalizeStore(dirty)
  eq('normalizeStore 丢弃重复 id', clean.folders.map((f) => f.id), ['f1', 'f2'])
  eq('normalizeStore 未知排序回落 manual', clean.folders[1].sort, 'manual')
  eq('normalizeStore 保留 name 排序', normalizeStore({ folders: [{ id: 'f3', name: 'C', sort: 'name' }] }).folders[0].sort, 'name')
  eq('normalizeStore 修剪卷宗名', clean.folders[1].name, '卷宗B')
  eq('normalizeStore 一会话一条归属', clean.entries.map((e) => e.sessionId), ['s1'])
  eq('normalizeStore 保留首条归属', clean.entries[0].folderId, 'f1')
  eq('normalizeStore 非法 handoff 剔除', Object.keys(clean.handoffs), ['s1'])
  check('normalizeStore 非对象输入安全', normalizeStore(null).folders.length === 0)
  eq('normalizeStore 置顶默认关闭', clean.folders[0].pinned, false)
  eq(
    'normalizeStore 记住置顶',
    normalizeStore({ folders: [{ id: 'f9', name: 'X', pinned: true }] }).folders[0].pinned,
    true,
  )
  eq('normalizeStore 老交接记录按 1 次算', clean.handoffs.s1.count, 1)
  eq('normalizeStore 记住交接次数', normalizeStore({ handoffs: { x: { path: '/x.md', count: 7 } } }).handoffs.x.count, 7)
  check(
    'normalizeStore 交接次数至少为 1',
    normalizeStore({ handoffs: { x: { path: '/x.md', count: 0 } } }).handoffs.x.count === 1,
  )

  /* --------------------------------------------------------- 3. 文档渲染 */

  const doc = renderDoc({
    title: '卷宗插件',
    body: '## 目标\n做文件夹与交接。\n',
    sessionId: 'sess-abc',
    folderName: '卷宗A',
    stage: 2,
    date: new Date(2026, 10, 4, 9, 5),
  })
  check('renderDoc 有标题', doc.startsWith('# 卷宗插件\n'), doc.slice(0, 20))
  check('renderDoc 记卷宗', doc.includes('- 卷宗：卷宗A'))
  check('renderDoc 阶段补零', doc.includes('- 阶段：02'))
  check('renderDoc 记时间', doc.includes('2026-11-04 09:05'))
  check('renderDoc 记会话', doc.includes('- 会话：sess-abc'))
  check('renderDoc 含接手提示', doc.includes('先读「下一步」与「已否决的方案」再动手'))
  check('renderDoc 正文原样', doc.includes('## 目标\n做文件夹与交接。'))
  check('renderDoc 结尾单换行', doc.endsWith('做文件夹与交接。\n'))

  /* ------------------------------------------------------- 4. 写操作流程 */

  const empty = stateOf(ctx, conf, 's1')
  eq('初始无卷宗', empty.folders.length, 0)
  eq('初始无归属', empty.entries.length, 0)
  eq('状态带路径', empty.paths.handoffRoot, join(cwd, 'goals'))

  const created = applyOp(ctx, conf, { op: 'folder.create', name: '卷宗A' })
  const folderA = created.folders[0]
  check('创建卷宗返回 id', typeof folderA.id === 'string' && folderA.id.length > 0)
  const folderB = applyOp(ctx, conf, { op: 'folder.create', name: '卷宗B' }).folders.find((f) => f.name === '卷宗B')

  let threw = false
  try {
    applyOp(ctx, conf, { op: 'folder.create', name: '卷宗A' })
  } catch {
    threw = true
  }
  check('重名卷宗被拒', threw)

  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: folderA.id })
  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's2', folderId: folderA.id })
  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's3', folderId: folderA.id })
  const assigned = stateOf(ctx, conf, 's1')
  eq('三条归属', assigned.entries.map((e) => [e.sessionId, e.order]), [
    ['s1', 1],
    ['s2', 2],
    ['s3', 3],
  ])

  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: folderB.id })
  const moved = stateOf(ctx, conf, 's1')
  eq('换卷后只留一条', moved.entries.filter((e) => e.sessionId === 's1').length, 1)
  eq('换卷后归属正确', moved.entries.find((e) => e.sessionId === 's1').folderId, folderB.id)

  // 重新归入 = 追加到卷宗末尾（不保留旧位置）
  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: folderA.id })
  eq('重新归入追加到末尾', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s2', 's3', 's1'])
  applyOp(ctx, conf, { op: 'entry.move', sessionId: 's1', delta: -1 })
  eq('上移一位', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s2', 's1', 's3'])
  applyOp(ctx, conf, { op: 'entry.move', sessionId: 's1', delta: -1 })
  eq('再上移一位', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s1', 's2', 's3'])
  applyOp(ctx, conf, { op: 'entry.move', sessionId: 's1', delta: -1 })
  eq('到顶再上移不越界', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s1', 's2', 's3'])
  applyOp(ctx, conf, { op: 'entry.move', sessionId: 's1', delta: 1 })
  eq('下移一位', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s2', 's1', 's3'])
  applyOp(ctx, conf, { op: 'entry.move', sessionId: 's1', delta: -1 })
  eq('移回原位', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s1', 's2', 's3'])
  eq('移动后序号连续', stateOf(ctx, conf).entries.map((e) => e.order), [1, 2, 3])

  applyOp(ctx, conf, { op: 'folder.sort', id: folderA.id, sort: 'time' })
  eq('切换到按时间', stateOf(ctx, conf).folders.find((f) => f.id === folderA.id).sort, 'time')
  applyOp(ctx, conf, { op: 'folder.sort', id: folderA.id, sort: 'name' })
  eq('切换到按名称', stateOf(ctx, conf).folders.find((f) => f.id === folderA.id).sort, 'name')
  applyOp(ctx, conf, { op: 'folder.sort', id: folderA.id, sort: '瞎写' })
  eq('未知排序回落 manual', stateOf(ctx, conf).folders.find((f) => f.id === folderA.id).sort, 'manual')
  applyOp(ctx, conf, { op: 'folder.sort', id: folderA.id, sort: 'manual' })
  eq('切回手动', stateOf(ctx, conf).folders.find((f) => f.id === folderA.id).sort, 'manual')

  applyOp(ctx, conf, { op: 'folder.pin', id: folderA.id, pinned: true })
  eq('卷宗置顶记为 pinned', stateOf(ctx, conf).folders.find((f) => f.id === folderA.id).pinned, true)
  applyOp(ctx, conf, { op: 'folder.pin', id: folderA.id, pinned: false })
  eq('取消卷宗置顶', stateOf(ctx, conf).folders.find((f) => f.id === folderA.id).pinned, false)
  let pinFolderMissing = false
  try {
    applyOp(ctx, conf, { op: 'folder.pin', id: 'nope', pinned: true })
  } catch {
    pinFolderMissing = true
  }
  check('置顶不存在的卷宗被拒', pinFolderMissing)

  /* 卷宗自身顺序：默认顺序可调，左栏跟着它走 */
  eq('新建卷宗排在最后', stateOf(ctx, conf).folders.map((f) => f.name), ['卷宗A', '卷宗B'])
  eq('卷宗序号连续', stateOf(ctx, conf).folders.map((f) => f.order), [1, 2])
  applyOp(ctx, conf, { op: 'folder.move', id: folderB.id, delta: -1 })
  eq('卷宗上移', stateOf(ctx, conf).folders.map((f) => f.name), ['卷宗B', '卷宗A'])
  applyOp(ctx, conf, { op: 'folder.move', id: folderB.id, delta: -1 })
  eq('卷宗到顶不越界', stateOf(ctx, conf).folders.map((f) => f.name), ['卷宗B', '卷宗A'])
  applyOp(ctx, conf, { op: 'folder.move', id: folderB.id, delta: 1 })
  eq('卷宗下移', stateOf(ctx, conf).folders.map((f) => f.name), ['卷宗A', '卷宗B'])
  eq('卷宗移动后序号连续', stateOf(ctx, conf).folders.map((f) => f.order), [1, 2])
  const folderMoveMissing = (() => {
    try {
      applyOp(ctx, conf, { op: 'folder.move', id: 'nope', delta: 1 })
      return false
    } catch {
      return true
    }
  })()
  check('移动不存在的卷宗会报错', folderMoveMissing)

  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's3', folderId: null })
  eq('移出卷宗', stateOf(ctx, conf).entries.map((e) => e.sessionId), ['s1', 's2'])

  applyOp(ctx, conf, { op: 'entry.pin', sessionId: 's2', pinned: true })
  eq('置顶记为 pinned', stateOf(ctx, conf).entries.find((e) => e.sessionId === 's2').pinned, true)
  eq('置顶不改序号', stateOf(ctx, conf).entries.map((e) => e.order), [1, 2])
  applyOp(ctx, conf, { op: 'entry.move', sessionId: 's2', delta: -1 })
  eq('置顶的那条不会和未置顶的串位', stateOf(ctx, conf).entries.find((e) => e.sessionId === 's2').order, 2)
  applyOp(ctx, conf, { op: 'entry.pin', sessionId: 's2', pinned: false })
  eq('取消置顶', stateOf(ctx, conf).entries.find((e) => e.sessionId === 's2').pinned, false)
  const pinMissing = (() => {
    try {
      applyOp(ctx, conf, { op: 'entry.pin', sessionId: 'not-there', pinned: true })
      return false
    } catch {
      return true
    }
  })()
  check('给不在卷宗里的对话置顶会报错', pinMissing)

  const unknownOp = (() => {
    try {
      applyOp(ctx, conf, { op: 'nope' })
      return false
    } catch {
      return true
    }
  })()
  check('未知操作报错', unknownOp)

  /* --------------------------------------------------------- 5. 交接落盘 */

  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: folderA.id })
  const first = writeHandoff(ctx, conf, {
    sessionId: 's1',
    title: '卷宗插件 起步',
    body: '## 目标\n把对话分卷并交接。\n\n## 下一步\n1. 装插件并截图验收。\n',
  })
  check('交接返回成功', first.ok === true)
  check('交接写到项目里', first.path === join(cwd, 'goals', '卷宗A', '阶段-01-卷宗插件-起步.md'), first.path)
  check('交接文件存在', existsSync(first.path))
  check('交接自动备份', Boolean(first.backup) && existsSync(first.backup), first.backup)
  check('备份落在 BACKUP_ROOT 下', first.backup.startsWith(backupRoot), first.backup)
  check('交接统计 token', first.tokens > 20 && first.tokens < 400, String(first.tokens))
  eq('短文档无警告', first.warnings, [])
  const written = readFileSync(first.path, 'utf8')
  check('文件头记卷宗', written.includes('- 卷宗：卷宗A'))
  check('文件头记阶段', written.includes('- 阶段：01'))

  const second = writeHandoff(ctx, conf, { sessionId: 's1', title: '卷宗插件 起步', body: '## 目标\n第二轮。\n' })
  eq('阶段自动递增', second.stage, 2)
  check('第二阶段文件名', second.path.endsWith('阶段-02-卷宗插件-起步.md'), second.path)
  eq('第一次交接记 1 次', first.count, 1)
  eq('每次交接都累加次数', second.count, 2)
  eq('存储里按会话记次数', stateOf(ctx, conf).handoffs.s1.count, 2)
  check('备份目录按工作区分子目录', readdirSync(backupRoot).length === 1, JSON.stringify(readdirSync(backupRoot)))

  const secret = writeHandoff(ctx, conf, {
    sessionId: 's2',
    title: '带密钥',
    body: `## 目标\n连接 10.0.0.9，key 是 sk-abcdefghijklmnopqrst。\n`,
  })
  check('检出内网地址', secret.warnings.some((w) => w.includes('内网')), JSON.stringify(secret.warnings))
  check('检出 API key', secret.warnings.some((w) => w.includes('API key')), JSON.stringify(secret.warnings))

  const long = writeHandoff(ctx, conf, {
    sessionId: 's2',
    title: '超长',
    body: `## 目标\n${'很长的说明。'.repeat(600)}\n`,
  })
  check('超长文档给警告', long.warnings[0].startsWith('篇幅偏长'), long.warnings[0])

  let noBody = false
  try {
    writeHandoff(ctx, conf, { sessionId: 's1', title: 'x', body: '   ' })
  } catch {
    noBody = true
  }
  check('空正文被拒', noBody)

  let noSid = false
  try {
    writeHandoff(ctx, conf, { title: 'x', body: 'y' })
  } catch {
    noSid = true
  }
  check('缺会话 id 被拒', noSid)

  /* ------------------------------------------- 5.5 没有卷宗的文档落在主文件夹 */

  const loose = writeHandoff(ctx, conf, { sessionId: 'no-folder-1', title: '散装', body: '## 目标\n没有卷宗的对话。\n' })
  check('无卷宗直接写主文件夹', loose.path === join(cwd, 'goals', '阶段-01-散装.md'), loose.path)
  check('无卷宗文档存在', existsSync(loose.path))

  const docs = docsOf(ctx, conf, 's1')
  eq('交接文档主目录', docs.root, join(cwd, 'goals'))
  check(
    '每个卷宗都有同名子文件夹',
    docs.folders.some((folder) => folder.name === '卷宗A'),
    JSON.stringify(docs.folders.map((f) => f.name)),
  )
  eq('卷宗A 下有四份文档（s1 两份、s2 两份）', docs.folders.find((f) => f.name === '卷宗A').files.length, 4)
  eq('主文件夹里有一份散装文档', docs.loose.length, 1)
  eq('散装文档按文件名列出', docs.loose[0].name, '阶段-01-散装.md')
  check('文档数统计正确', docs.total === 5, String(docs.total))

  applyOp(ctx, conf, { op: 'folder.create', name: '新卷宗', viewSessionId: 's1' })
  check('新建卷宗时建好同名子文件夹', existsSync(join(cwd, 'goals', '新卷宗')))

  /* ---------------------------------------- 5.6 交接文档的导出 / 删除 */

  const outDir = join(cwd, 'export-out')
  const src = loose.path

  let noTarget = false
  try {
    docOp(ctx, conf, { op: 'export', files: [src], viewSessionId: 's1' })
  } catch {
    noTarget = true
  }
  check('没指定导出目录被拒', noTarget)

  const exported = docOp(ctx, conf, { op: 'export', files: [src], targetDir: outDir, viewSessionId: 's1' })
  check('导出一份成功', exported.done.length === 1 && existsSync(join(outDir, '阶段-01-散装.md')), JSON.stringify(exported.failed))
  eq('导出内容与原文一致', readFileSync(join(outDir, '阶段-01-散装.md'), 'utf8'), readFileSync(src, 'utf8'))

  docOp(ctx, conf, { op: 'export', files: [src], targetDir: outDir, viewSessionId: 's1' })
  check('重名导出自动加后缀', existsSync(join(outDir, '阶段-01-散装-2.md')))

  const outside = docOp(ctx, conf, { op: 'delete', files: [storePath], viewSessionId: 's1' })
  eq('目录外的文件拒绝删除', outside.failed.length, 1)
  check('目录外的文件原样还在', existsSync(storePath))

  const removed = docOp(ctx, conf, { op: 'delete', files: [src], viewSessionId: 's1' })
  check('删除成功', removed.done.length === 1 && !existsSync(src))
  eq('删除后主文件夹里就没这份了', docsOf(ctx, conf, 's1').loose.length, 0)

  /* ---------------------------------------- 5.7 交接文档整包导出 / 导入 */

  writeHandoff(ctx, conf, { sessionId: 's1', title: '打包甲', body: '## 目标\n甲' })
  writeHandoff(ctx, conf, { sessionId: 's2', title: '打包乙', body: '## 目标\n乙' })

  const bundleDir = join(cwd, 'bundle-out')
  let noBundleTarget = false
  try {
    docOp(ctx, conf, { op: 'exportBundle', viewSessionId: 's1' })
  } catch {
    noBundleTarget = true
  }
  check('整包导出没指定目录被拒', noBundleTarget)

  const bundled = docOp(ctx, conf, { op: 'exportBundle', targetDir: bundleDir, viewSessionId: 's1' })
  check('整包导出成功', bundled.count >= 2 && existsSync(bundled.file), JSON.stringify(bundled))
  const bundleJson = JSON.parse(readFileSync(bundled.file, 'utf8'))
  check('整包是 schema 1 的交接包', bundleJson.schema === 1 && bundleJson.kind === 'dossier-handoff')
  check('整包带每份文档的正文', bundleJson.files.every((item) => typeof item.content === 'string' && item.content.length))
  check('整包记住所属卷宗', bundleJson.files.some((item) => item.folder === '卷宗A'))
  /* 包里得带「这份是谁的交接」：不带的话换机器导入只能落到未归档，认不回对话 */
  check(
    '整包记住每份文档属于哪条对话',
    bundleJson.files.some((item) => item.sessionId === 's1') && bundleJson.files.some((item) => item.sessionId === 's2'),
    JSON.stringify(bundleJson.files.map((item) => [item.name, item.sessionId, item.folder])),
  )
  check(
    '整包记住阶段号',
    bundleJson.files.every((item) => Number.isFinite(item.stage) && item.stage >= 1),
    JSON.stringify(bundleJson.files.map((item) => [item.name, item.stage])),
  )

  const again = docOp(ctx, conf, { op: 'importBundle', bundle: bundleJson, viewSessionId: 's1' })
  check('同内容再导入全部跳过', again.done.length === bundleJson.files.length && again.done.every((item) => item.skipped))

  const changed = JSON.parse(JSON.stringify(bundleJson))
  changed.files[0].content = `${changed.files[0].content}\n补充一行。`
  const merged = docOp(ctx, conf, { op: 'importBundle', bundle: changed, viewSessionId: 's1' })
  const importedNew = merged.done.filter((item) => !item.skipped)
  check(
    '内容不同则另存不覆盖',
    importedNew.length === 1 && /-2\.md$/.test(importedNew[0].to) && existsSync(importedNew[0].to),
    JSON.stringify(merged.done),
  )
  eq('其余同内容仍然跳过', merged.done.filter((item) => item.skipped).length, bundleJson.files.length - 1)

  let badBundle = false
  try {
    docOp(ctx, conf, { op: 'importBundle', bundle: { files: [] }, viewSessionId: 's1' })
  } catch {
    badBundle = true
  }
  check('不是卷宗导出的包会被拒', badBundle)

  /* ------------------------- 5.8 交接文档跟着卷宗列表走：删掉的卷宗不再单列 */

  /* 模拟「以前建过卷宗、导入了对话、后来把卷宗删了」：盘上目录还在 */
  const orphanDir = join(cwd, 'goals', '旧卷宗')
  mkdirSync(orphanDir, { recursive: true })
  writeFileSync(join(orphanDir, '阶段-01-旧.md'), '# 旧\n')

  const docsAfterOrphan = docsOf(ctx, conf, 's1')
  check('旧卷宗的文件夹不再单列', !docsAfterOrphan.folders.some((folder) => folder.name === '旧卷宗'), JSON.stringify(docsAfterOrphan.folders.map((f) => f.name)))
  check(
    '旧卷宗里的文档并进未归档并记下出处',
    docsAfterOrphan.loose.some((file) => file.name === '阶段-01-旧.md' && file.origin === '旧卷宗'),
    JSON.stringify(docsAfterOrphan.loose.map((f) => [f.name, f.origin])),
  )

  /* 排序：有文档的按最新一份倒序在前，没文档的按名称在后 */
  const withFiles = docsAfterOrphan.folders.filter((folder) => folder.files.length)
  const empties = docsAfterOrphan.folders.filter((folder) => !folder.files.length)
  check(
    '有文档的文件夹排在没文档的前面',
    docsAfterOrphan.folders.slice(0, withFiles.length).every((folder) => folder.files.length > 0),
    JSON.stringify(docsAfterOrphan.folders.map((f) => [f.name, f.files.length])),
  )
  check(
    '有文档的文件夹按最新一份倒序',
    withFiles.every((folder, index) => index === 0 || withFiles[index - 1].latestAt >= folder.latestAt),
    JSON.stringify(withFiles.map((f) => [f.name, f.latestAt])),
  )
  const emptyNames = empties.map((folder) => folder.name)
  check(
    '没文档的文件夹按名称排',
    JSON.stringify(emptyNames) === JSON.stringify(emptyNames.slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))),
    JSON.stringify(emptyNames),
  )
  eq('docsOf 的 total 含并过来的旧文档', docsAfterOrphan.total, docsAfterOrphan.folders.reduce((sum, f) => sum + f.files.length, 0) + docsAfterOrphan.loose.length)

  /* 删掉一个有交接文档的卷宗：它的文档立刻从分组里消失、并进未归档 */
  const folderC = applyOp(ctx, conf, { op: 'folder.create', name: '卷宗C' }).folders.find((f) => f.name === '卷宗C')
  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's2', folderId: folderC.id })
  writeHandoff(ctx, conf, { sessionId: 's2', title: '卷宗C 文档', body: '## 目标\nC 的交接。\n' })
  check('卷宗C 有自己的文件夹', existsSync(join(cwd, 'goals', '卷宗C')))
  check('删之前它是个分组', docsOf(ctx, conf, 's2').folders.some((folder) => folder.name === '卷宗C'))

  applyOp(ctx, conf, { op: 'folder.remove', id: folderC.id })
  const afterRemove = docsOf(ctx, conf, 's2')
  check('删卷宗后不再列出它的分组', !afterRemove.folders.some((folder) => folder.name === '卷宗C'))
  check(
    '删卷宗后它的文档进了未归档',
    afterRemove.loose.some((file) => file.name.includes('卷宗C') && file.origin === '卷宗C'),
    JSON.stringify(afterRemove.loose.map((f) => [f.name, f.origin])),
  )
  check('盘上的目录还在（没替用户删文件）', existsSync(join(cwd, 'goals', '卷宗C')))

  /* ------------------------- 5.9 交接文档跟着对话走：不搬文件，只换归组 */
  const folderD = applyOp(ctx, conf, { op: 'folder.create', name: '卷宗D' }).folders.find((f) => f.name === '卷宗D')
  const beforeMove = docsOf(ctx, conf, 's1')
  const aFiles = beforeMove.folders.find((folder) => folder.name === '卷宗A').files
  const followed = aFiles.find((file) => file.sessionId === 's1')
  check('挪之前文档挂在卷宗A', Boolean(followed), JSON.stringify(beforeMove.folders.map((f) => [f.name, f.files.length])))
  const followedPath = followed ? followed.path : ''
  check('文档记着自己是哪条对话生成的', Boolean(followed), JSON.stringify(aFiles.map((f) => [f.name, f.sessionId])))

  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: folderD.id })
  const afterMove = docsOf(ctx, conf, 's1')
  check(
    '挪走对话后卷宗A不再挂这份文档',
    !afterMove.folders.find((folder) => folder.name === '卷宗A').files.some((file) => file.path === followedPath),
  )
  check(
    '文档跟着对话出现在卷宗D下面',
    afterMove.folders.find((folder) => folder.name === '卷宗D').files.some((file) => file.path === followedPath),
  )
  check('盘上的文件没被搬走', existsSync(followedPath) && followedPath.includes('卷宗A'), followedPath)

  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: null })
  const afterUnassign = docsOf(ctx, conf, 's1')
  check(
    '对话移出卷宗后文档回到未归档',
    afterUnassign.loose.some((file) => file.path === followedPath),
    JSON.stringify({ followedPath, folders: afterUnassign.folders.map((f) => [f.name, f.files.map((x) => x.name)]), loose: afterUnassign.loose.map((f) => f.name) }),
  )
  applyOp(ctx, conf, { op: 'entry.assign', sessionId: 's1', folderId: folderA.id })

  /* --------------- 5.10 换机器导入：对话不在了，也要按导出时的卷宗归位 */
  const storeJson = JSON.parse(readFileSync(storePath, 'utf8'))
  delete storeJson.handoffs.s1
  storeJson.entries = storeJson.entries.filter((entry) => entry.sessionId !== 's1')
  writeFileSync(storePath, JSON.stringify(storeJson, null, 2), 'utf8')

  const migrate = JSON.parse(JSON.stringify(bundleJson))
  migrate.files = migrate.files
    .filter((item) => item.sessionId === 's1')
    .map((item) => ({ ...item, name: item.name.replace(/\.md$/, '-mv.md'), content: `${item.content}\n换机器的补充。` }))
  const migrated = docOp(ctx, conf, { op: 'importBundle', bundle: migrate, viewSessionId: 's1' })
  check('导入把交接记录接回来', Boolean(migrated.restored), JSON.stringify(migrated))
  const migratedHandoff = stateOf(ctx, conf).handoffs.s1
  check('接回来的记录标着是导入的', Boolean(migratedHandoff) && migratedHandoff.imported === true, JSON.stringify(migratedHandoff))
  const afterMigrate = docsOf(ctx, conf, 's1')
  check(
    '对话不在也按导出时的卷宗归位',
    (afterMigrate.folders.find((folder) => folder.name === '卷宗A') || { files: [] }).files.some((file) => /-mv\.md$/.test(file.name)),
    JSON.stringify(afterMigrate.folders.map((f) => [f.name, f.files.map((x) => x.name)])),
  )

  /* 冷会话（进程里没有这个 session）从会话日志里读用量 */
  const coldCtx = fakeCtx({
    sessionPersistence: {
      open: async (id) => ({
        id,
        header: { id },
        read: async () => ({
          eventState: {},
          events: [
            { type: 'user/message', time: 1000 },
            { type: 'step/start', time: 1100 },
            { type: 'step/start', time: 1200 },
            {
              type: 'assistant/message',
              time: 1300,
              data: { usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 9000 } },
            },
          ],
        }),
        close: async () => {},
      }),
    },
  })
  const cold = await usageOfCold(coldCtx, 'cold-1')
  check('冷会话从日志读出步数与消息数', cold && cold.live === false && cold.steps === 2 && cold.userMessages === 1, JSON.stringify(cold))
  eq('冷会话上下文 = 未命中 + 命中', cold.contextTokens, 10000)
  check('冷会话没有面板块但也能算钱', cold.lastCost > 0)
  eq('没有 sessionPersistence 时返回 null', await usageOfCold(fakeCtx({}), 'cold-2'), null)

  /* ------------------------------------------------------- 6. 持久化回落 */

  const reloaded = JSON.parse(readFileSync(storePath, 'utf8'))
  check('存储文件已写', reloaded.schema === 1)
  eq('存储记住交接记录', Object.keys(reloaded.handoffs).sort(), ['no-folder-1', 's1', 's2'])
  check('交接记录带阶段', reloaded.handoffs.s1.stage >= 2)
  check('存储写入留下 .bak', existsSync(`${storePath}.bak`))

  writeFileSync(storePath, '{ 坏掉的 json', 'utf8')
  eq('坏存储不炸、回落到空', stateOf(ctx, conf).folders.length, 0)
  writeFileSync(storePath, JSON.stringify(dirty), 'utf8')
  eq('脏存储被清洗', stateOf(ctx, conf).folders.map((f) => f.id), ['f1', 'f2'])
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------- 6.5 会话目录解析（可选访问） */

const coldCtx = fakeCtx({
  workspaceRegistry: {
    list: () => [
      { id: 'w1', path: join(root, 'other-workspace'), sessionIds: ['cold-1'] },
      { id: 'w2', path: join(root, 'third'), sessionIds: ['cold-2'] },
    ],
  },
})
eq(
  '冷会话按工作区注册表解析目录',
  stateOf(coldCtx, conf, 'cold-1').paths.cwd,
  join(root, 'other-workspace'),
)
eq(
  '交接目录跟着工作区走',
  stateOf(coldCtx, conf, 'cold-2').paths.handoffRoot,
  join(root, 'third', 'goals'),
)
eq('未知会话回落部署目录', stateOf(coldCtx, conf, 'nope').paths.cwd, cwd)
eq('未声明注入也不抛错', stateOf(fakeCtx({}), conf, 'cold-1').paths.cwd, cwd)

/* ------------------------------- 7. apply() 的装配（模拟 Cordis 注入语义） */

const { apply } = await import('../index.js')

const registered = []
const routes = []

function fakeCtx(services) {
  return {
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: cwd, get: () => cwd },
    logger: { warn() {} },
    // Cordis 的可选访问：ctx.get(name)，未注入/未提供时返回 undefined
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return this[name]
    },
    // Cordis 语义：注入的服务只出现在 child 上，外层 ctx 看不到
    inject(dependencies, callback) {
      const child = { ...this }
      for (const dependency of dependencies) {
        if (!(dependency in services)) return undefined
        child[dependency] = services[dependency]
      }
      return callback(child)
    },
  }
}

const fullCtx = fakeCtx({
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
})

apply(fullCtx, {})

eq('apply 注册了工具', registered.map((t) => t.name), ['dossier_handoff_write'])
eq('apply 注册了六条路由', routes.map((r) => r.path).sort(), [
  '/dsh-dossier/docop',
  '/dsh-dossier/docs',
  '/dsh-dossier/handoff',
  '/dsh-dossier/op',
  '/dsh-dossier/state',
  '/dsh-dossier/usage',
])
check('工具参数必填两项', JSON.stringify(registered[0].parameters.required) === '["title","body"]')
check('工具描述含骨架', registered[0].description.includes('已否决的方案'))
check('工具描述含硬规则', registered[0].description.includes('1500'))
check('工具输出可渲染', Array.isArray(registered[0].output.render({}, { ok: true, path: '/x.md', tokens: 12 })))

const viaTool = await registered[0].execute(
  { title: '工具直调', body: '## 目标\n验证 execute 能落盘。\n' },
  { agent: { id: 's1' } },
)
check('工具 execute 落盘', existsSync(viaTool.path), viaTool.path)
check('工具 execute 带阶段', viaTool.stage >= 1)
const rendered = registered[0].output.render({}, viaTool).map((block) => block.text).join('\n')
check('工具输出含路径', rendered.includes(viaTool.path))

// 缺少 webServer / tools 时：不抛错、不注册
const bareCtx = fakeCtx({})
let bareThrew = false
try {
  apply(bareCtx, {})
} catch {
  bareThrew = true
}
check('缺服务时不抛错', !bareThrew)

/* ------------------------------------------------------- 8. 用量与费用估算 */

const cold = estimateCost({ inputTokens: 716319, outputTokens: 1570, cacheReadTokens: 0 }, 'peak')
check('冷启动 71.6 万 token 峰值 ≈ ¥1.44', cold.cost > 1.43 && cold.cost < 1.45, String(cold.cost))
check('冷启动全部算未命中', cold.miss === 716319)

const warm = estimateCost({ inputTokens: 22400, outputTokens: 1570, cacheReadTokens: 716319 }, 'peak')
check('同一段上下文的暖启动 ≈ ¥0.086（冷启动的十七分之一）', warm.cost > 0.085 && warm.cost < 0.087, String(warm.cost))
check('上下文长度 = 未命中 + 命中', warm.total === 738719)

const half = estimateCost({ inputTokens: 50000, outputTokens: 0, cacheReadTokens: 50000 }, 'idle')
check('未命中与命中分别计价', Math.abs(half.cost - (50000 * 1 + 50000 * 0.02) / 1e6) < 1e-9)

eq('上午 9 点算高峰', priceBand(new Date(2026, 10, 4, 9, 30)), 'peak')
eq('中午 13 点算空闲', priceBand(new Date(2026, 10, 4, 13, 0)), 'idle')
eq('下午 14 点算高峰', priceBand(new Date(2026, 10, 4, 14, 0)), 'peak')
eq('傍晚 18 点算空闲', priceBand(new Date(2026, 10, 4, 18, 0)), 'idle')

eq('未知会话不算活着', usageOf(fakeCtx({}), 'nope').live, false)

const liveCtx = fakeCtx({
  sessions: {
    get: () => ({
      ownEvents: () => [
        { type: 'turn/start', time: 1000 },
        { type: 'step/start', time: 1100, data: { turn: 1, step: 1 } },
        { type: 'user/message', time: 1200, data: {} },
        { type: 'assistant/message', time: 2000, data: { usage: { inputTokens: 120000, outputTokens: 800, cacheReadTokens: 60000 } } },
        { type: 'step/end', time: 2050 },
        { type: 'turn/end', time: 2100 },
        { type: 'turn/start', time: 3000 },
        { type: 'step/start', time: 3100, data: { turn: 2, step: 1 } },
        { type: 'assistant/message', time: 4000, data: { usage: { inputTokens: 150000, outputTokens: 900, cacheReadTokens: 140000 } } },
        { type: 'step/end', time: 4050 },
        { type: 'turn/end', time: 4100 },
      ],
    }),
  },
  sessionProjections: {
    snapshot: () => ({ contextPressure: { projectedTokens: 163000, contextWindow: 1000000 } }),
  },
})
const live = usageOf(liveCtx, 's1')
eq('活会话两轮', live.turns, 2)
eq('活会话两步', live.steps, 2)
eq('活会话一条用户消息', live.userMessages, 1)
eq('上下文取投影值', live.contextTokens, 163000)
eq('上下文窗口取投影值', live.contextWindow, 1000000)
eq('取最后一次调用的输入', live.lastInput, 150000)
eq('取最后一次调用的命中量', live.lastCacheRead, 140000)
check('最后一次调用 ≈ ¥0.156（15 万未命中 + 14 万命中）', live.lastCost > 0.155 && live.lastCost < 0.158, String(live.lastCost))
eq('最后一次调用的上下文长度', live.lastTotal, 150000 + 140000)
eq('命中率按 48% 算', live.lastHitRate, 48)

const noProjectionCtx = fakeCtx({
  sessions: {
    get: () => ({
      ownEvents: () => [
        { type: 'assistant/message', time: 5000, data: { turn: 1, usage: { inputTokens: 42000, outputTokens: 300, cacheReadTokens: 40000 } } },
        { type: 'assistant/message', time: 6000, data: { turn: 2, usage: { inputTokens: 44000, outputTokens: 320, cacheReadTokens: 43000 } } },
      ],
    }),
  },
})
const fallback = usageOf(noProjectionCtx, 's2')
eq('没有投影时按调用轮数推算', fallback.turns, 2)
eq('没有投影时用上次请求长度当上下文', fallback.contextTokens, 44000 + 43000)

/* ------------------------------------------------------------------ 汇总 */

if (failures.length) {
  console.log(`FAIL  ${failures.length} 项未通过（通过 ${passed} 项）`)
  for (const item of failures) console.log(`  ✗ ${item}`)
  process.exitCode = 1
} else {
  console.log(`PASS  ${passed} 项断言全部通过`)
}
