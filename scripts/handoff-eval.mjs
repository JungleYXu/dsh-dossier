/**
 * 交接文档体检 + 盲接探针提示词。
 *
 *   node scripts/handoff-eval.mjs <文档.md> [--cwd <工作区目录>]
 *
 * 体检的是「这份文档能不能独立交接」：骨架齐不齐、下一步能不能直接做、
 * 引用的文件在不在、有没有超预算或夹带密钥。退出码 1 = 有硬伤。
 * 最后打印一段提示词：粘进一个全新对话（不带历史），看它能否只凭文档说清
 * 下一步做什么 —— 这一步只能人跑，脚本只负责把口径固定下来。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SECTIONS = ['目标', '当前状态', '关键决策', '已否决的方案', '约束', '涉及文件', '下一步', '未解决与风险']

function splitSections(source) {
  const map = new Map()
  let current = ''
  let buffer = []
  const flush = () => {
    if (current) map.set(current, buffer.join('\n').trim())
  }
  for (const line of source.split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      current = match[1].replace(/[（(].*$/, '').trim()
      buffer = []
    } else if (current) {
      buffer.push(line)
    }
  }
  flush()
  return map
}

function bullets(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''))
}

function numbered(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^\d+[.)]\s+/, ''))
}

/**
 * 体检一份交接文档。返回 { passed, failed, warned, tokens }。
 * cwd 用来校验正文里引用的相对路径；docDir 是文档所在目录，作为第二候选。
 */
export function evaluateHandoff(text, options = {}) {
  const cwd = resolve(options.cwd || process.cwd())
  const docDir = options.docDir || cwd
  const { estimateTokens, scanSecrets } = options.tools

  const lines = text.split(/\r?\n/)
  const sections = splitSections(text)
  const passed = []
  const failed = []
  const warned = []

  const ok = (label, detail) => passed.push(detail ? `${label} — ${detail}` : label)
  const bad = (label, detail) => failed.push(detail ? `${label} — ${detail}` : label)
  const warn = (label, detail) => warned.push(detail ? `${label} — ${detail}` : label)

  for (const name of SECTIONS) {
    if (sections.has(name)) ok(`有「${name}」`)
    else bad(`缺「${name}」`)
  }

  const tokens = estimateTokens(text)
  if (tokens <= 1500) ok(`预算内：约 ${tokens} token`)
  else bad(`超预算：约 ${tokens} token（上限 1500）`)

  if (/```/.test(text)) bad('含代码块（硬规则：不贴代码）')
  else ok('没有代码块')

  const longLine = lines.find((line) => line.length > 400)
  if (longLine) bad(`有一行 ${longLine.length} 字符（像是贴了日志）`)
  else ok('没有超长行')

  const secrets = scanSecrets(text)
  if (secrets.length) bad(`疑似密钥/内网地址：${secrets.join('、')}`)
  else ok('没有密钥与内网地址')

  if (/本次会话中我们|我们讨论了|如上所述|综上所述/.test(text)) bad('含过程/寒暄口吻（写状态，不写故事）')
  else ok('没有过程口吻')

  /* 目标：一句话说清要达成什么 */
  const goal = (sections.get('目标') || '').trim()
  if (!goal) bad('「目标」为空')
  else if (goal.length > 260) bad(`「目标」太长（${goal.length} 字符），应是 1 句话`)
  else ok('目标是一句话')

  /* 当前状态：带证据，不是形容词 */
  const stateItems = bullets(sections.get('当前状态') || '')
  if (!stateItems.length) bad('「当前状态」没有条目')
  else {
    const withEvidence = stateItems.filter((item) => /[\d`]|通过|PASS|项断言|文件|路径/.test(item))
    if (withEvidence.length >= Math.min(2, stateItems.length)) ok('当前状态带证据', `${withEvidence.length}/${stateItems.length} 条`)
    else bad('「当前状态」缺少证据（数字、路径、命令或测试结果）')
  }

  /* 关键决策：每条都要有「→ 理由」 */
  const decisions = bullets(sections.get('关键决策') || '')
  if (!decisions.length) bad('「关键决策」没有条目')
  else {
    const noReason = decisions.filter((item) => !item.includes('→'))
    if (noReason.length) bad(`关键决策缺理由（${noReason.length} 条没有「→」）`, noReason[0])
    else ok('关键决策都带理由', `${decisions.length} 条`)
  }

  /* 已否决：最贵的一节，必须写清楚为什么否决 */
  const rejectedBody = sections.get('已否决的方案') || ''
  const rejected = bullets(rejectedBody)
  if (!rejected.length && !/^无[。.]?$/m.test(rejectedBody.trim())) bad('「已否决的方案」为空（没有就写「无」）')
  else if (rejected.length) {
    const noReason = rejected.filter((item) => !item.includes('→'))
    if (noReason.length) bad(`已否决缺理由（${noReason.length} 条没有「→」）`, noReason[0])
    else {
      ok('已否决都带理由', `${rejected.length} 条`)
      // 只写结论，接手的人知道「别这么做」却不知道「这么做会怎样」——要求补上症状。
      const notThreePart = rejected.filter((item) => (item.match(/→/g) || []).length < 2)
      if (notThreePart.length) bad(`已否决缺「症状」段（${notThreePart.length}/${rejected.length} 条不是「做法 → 症状 → 结论」）`, notThreePart[0].slice(0, 70))
      else ok('已否决是三段式', `${rejected.length} 条`)
    }
  } else ok('已否决写的是「无」')

  if (!(sections.get('约束') || '').trim()) bad('「约束」为空（没有就写「无」）')
  else ok('有约束')

  /* 下一步：逐条可执行、带验收标准 */
  const steps = numbered(sections.get('下一步') || '')
  if (!steps.length) bad('「下一步」没有编号条目')
  else {
    const noAccept = steps.filter((item) => !/验收|成功标准|判断标准|通过标准/.test(item))
    if (noAccept.length) bad(`下一步缺验收标准（${noAccept.length}/${steps.length} 条）`, noAccept[0].slice(0, 60))
    else ok('下一步都带验收标准', `${steps.length} 条`)
    const vague = steps.filter((item) => !/(改|加|删|跑|写|建|确认|验证|实点|更新|补|修|检查|对比|重启|开|点|装)/.test(item))
    if (vague.length) warn(`下一步有 ${vague.length} 条读不出具体动作`, vague[0].slice(0, 60))
  }

  if (!(sections.get('未解决与风险') || '').trim()) bad('「未解决与风险」为空（没有就写「无」）')
  else ok('有未解决与风险')

  /* 涉及文件 + 全文引用：路径必须真实存在，否则接手的人第一步就卡住 */
  const referenced = new Set()
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1].trim()
    if (!/[/\\]/.test(value) && !/\.(mjs|js|json|md|ts|tsx|css|html)$/.test(value)) continue
    if (value.includes('…') || value.includes('<') || value.includes('*') || value.includes(' ')) continue
    referenced.add(value)
  }

  const missing = []
  for (const ref of referenced) {
    if (ref.startsWith('~') || /^[a-z]+:\/\//i.test(ref)) continue
    const candidates = isAbsolute(ref) ? [ref] : [join(cwd, ref), join(docDir, ref)]
    if (!candidates.some((candidate) => existsSync(candidate))) missing.push(ref)
  }
  if (missing.length) bad(`引用的路径不存在（${missing.length} 个）`, missing.join('、'))
  else ok('引用的路径都存在', `${referenced.size} 个`)

  const entries = bullets(sections.get('涉及文件') || '')
  const noDesc = entries.filter((item) => !/—|-\s|：/.test(item))
  if (entries.length && noDesc.length) warn(`涉及文件有 ${noDesc.length} 条没写作用`)
  else if (entries.length) ok('涉及文件都有一句话作用', `${entries.length} 个`)

  return { passed, failed, warned, tokens }
}

export function probePrompt(text) {
  return [
    '你刚接手一个项目，手上只有下面这份交接文档，没有任何历史对话。',
    '只读文档回答，不要读仓库文件，不要猜：',
    '1. 这个项目的目标是什么？现在做到哪一步了？',
    '2. 「下一步」第 1 条具体要做什么？怎么算做成了？',
    '3. 文档里有哪些你无法验证、或看不懂的引用（文件、符号、数字）？',
    '4. 要开始干活，你还缺哪些信息？',
    '',
    '===== 文档开始 =====',
    text.trim(),
    '===== 文档结束 =====',
  ].join('\n')
}

/* ------------------------------------------------------------------- CLI */

async function main() {
  const args = process.argv.slice(2)
  const docPath = args.find((arg) => !arg.startsWith('--'))
  if (!docPath) {
    console.error('用法：node scripts/handoff-eval.mjs <文档.md> [--cwd <工作区目录>]')
    process.exit(2)
  }
  const cwdFlag = args.indexOf('--cwd')
  const cwd = cwdFlag >= 0 && args[cwdFlag + 1] ? resolve(args[cwdFlag + 1]) : process.cwd()

  const { __testing } = await import('../index.js')
  const text = readFileSync(docPath, 'utf8')
  const result = evaluateHandoff(text, {
    cwd,
    docDir: dirname(resolve(docPath)),
    tools: { estimateTokens: __testing.estimateTokens, scanSecrets: __testing.scanSecrets },
  })

  for (const line of result.passed) console.log(`  ok   ${line}`)
  for (const line of result.warned) console.log(`  warn ${line}`)
  for (const line of result.failed) console.log(`  FAIL ${line}`)

  console.log('')
  console.log(
    result.failed.length
      ? `FAIL  ${result.failed.length} 项硬伤（通过 ${result.passed.length} 项，提醒 ${result.warned.length} 项）`
      : `PASS  ${result.passed.length} 项检查通过（提醒 ${result.warned.length} 项）`,
  )

  console.log('')
  console.log('— 盲接探针：把下面这段粘进一个全新对话（不带任何历史），只让它读文档回答 —')
  console.log('')
  console.log(probePrompt(text))

  if (result.failed.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
