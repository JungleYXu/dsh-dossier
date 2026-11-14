// 客户端半边的离线冒烟：用最小 React 桩把 client.js 跑起来，检查渲染路径不抛错。
// 目的：面板空白时，先把「组件本身会不会抛」和「槽位注册有没有生效」分开。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
let passes = 0
function check(label, condition, detail) {
  if (condition) {
    passes += 1
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` → ${String(detail)}`}`)
  }
}

/* ------------------------------------------------ 最小 React 桩 */
let hookIndex = 0
let hookState = []

class Component {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }
}

const React = {
  Component,
  createElement(type, props, ...children) {
    const flat = children.length === 1 ? children[0] : children
    const merged = { ...(props || {}) }
    if (children.length) merged.children = flat
    return { type, props: merged, children: flat }
  },
  Fragment: 'Fragment',
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [hookState[index], () => {}]
  },
  useReducer(reducer, initial) {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = initial
    return [hookState[index], () => {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
}

/* ------------------------------------------------ 模块加载 */
let definition = null
const windowStub = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

globalThis.window = windowStub
globalThis.fetch = () => Promise.reject(new Error('offline'))

new Function('window', 'fetch', source)(windowStub, globalThis.fetch)

check('client.js 调用了 __ModuleLoader__.load', definition !== null)
check('factory 存在', definition && typeof definition.factory === 'function')
check('id 等于包名', definition && definition.id === 'dsh-dossier', definition && definition.id)

const require = (name) => {
  if (name === 'react') return React
  throw new Error(`不允许 require(${name})`)
}

const moduleExports = definition.factory(require)
check(
  'inject 声明了要用的客户端服务',
  JSON.stringify(moduleExports.inject) === '["slots","sessions","workspaces","uiWorkspace"]',
  JSON.stringify(moduleExports.inject),
)

/* ------------------------------------------------ ctx 桩 */
const registered = []
const ctx = {
  sessions: {
    list: {
      getSnapshot: () => ({
        ids: ['s-1'],
        byId: { 's-1': { id: 's-1', title: '测试对话', updatedAt: Date.now() - 60000 } },
        phase: 'ready',
      }),
    },
  },
  workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [], phase: 'ready' }) } },
  layout: { selectPanel() {} },
  uiWorkspace: { openSession() {} },
  slots: {
    inject(name, callback) {
      const dispose = callback()
      return dispose
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

let applyError = null
try {
  moduleExports.apply(ctx)
} catch (error) {
  applyError = error
}

check('apply 不抛错', applyError === null, applyError && applyError.message)
check('注册了三个槽位', registered.length === 3, registered.length)
check(
  '面板注册在 main',
  registered.some((item) => item.options.name === 'main' && item.options.key === 'dossier'),
)
check(
  '图标注册在 sidebar.panellist',
  registered.some((item) => item.options.name === 'sidebar.panellist' && item.options.id === 'dossier'),
)
check(
  '按钮注册在 conversation.input.left',
  registered.some((item) => item.options.name === 'conversation.input.left'),
)

/* ------------------------------------------------ 渲染各组件 */
function render(component, props) {
  hookIndex = 0
  hookState = []
  return instantiate(component, props)
}

// 把函数组件与类组件都展开到宿主元素
function instantiate(component, props) {
  if (typeof component === 'function' && component.prototype && component.prototype.render) {
    const instance = new component(props)
    instance.props = props || {}
    return instance.render()
  }
  return component(props || {})
}

function walk(node, visit, depth = 0) {
  if (node == null || depth > 80) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    const expanded = instantiate(node.type, node.props)
    walk(expanded, visit, depth + 1)
    return
  }
  visit(node)
  walk(node.children, visit, depth + 1)
}

const panel = registered.find((item) => item.options.name === 'main')
let panelTree = null
let panelError = null
try {
  panelTree = render(panel.component, {})
} catch (error) {
  panelError = error
}

check('面板渲染不抛错', panelError === null, panelError && `${panelError.message}\n${panelError.stack}`)
check('面板返回元素', panelTree && typeof panelTree === 'object')

let textCount = 0
const classes = new Set()
const classList = []
const hostTypes = new Set()
const texts = []
if (panelTree) {
  walk(panelTree, (node) => {
    hostTypes.add(node.type)
    if (typeof node.children === 'string') {
      textCount += 1
      texts.push(node.children)
    }
    if (node.props && typeof node.props.className === 'string') {
      classes.add(node.props.className.split(' ')[0])
      classList.push(node.props.className)
    }
  })
}
check('面板有 dz-page 类名', classes.has('dz-page'), [...classes].join(','))
check('面板渲染出文字节点', textCount >= 4, textCount)
check('面板渲染出 .dz-side', classes.has('dz-side'), [...classes].join(','))
check('面板渲染出 .dz-main', classes.has('dz-main'))
check('工具栏有「选择」按钮', texts.includes('选择'), texts.slice(0, 12).join('|'))
check(
  '「未归档」渲染成缩进子项',
  classList.some((name) => name.startsWith('dz-side-row') && name.includes('is-sub')),
  classList.join(','),
)
check('左栏有「卷宗」分组标题', texts.includes('卷宗'), texts.slice(0, 16).join('|'))
/* 空状态下没有卷宗行，只能从源码确认卷宗行与样式都接上了 */
check('左栏卷宗行带文件夹图标', source.includes('dz-side-ico') && source.includes('.dz-side-ico {'))
check('卷宗列表视图有卡片/列表文件夹图标', source.includes('.dz-fico') && source.includes("h('span', { key: 'ico', className: 'dz-fico' }"))

/* 有了一个会话，就能真的渲染出一行对话来检查图标与动作按钮 */
check('对话行渲染出标题', texts.includes('测试对话'), texts.slice(0, 16).join('|'))
check('对话行前面有可辨识的小图标', classList.some((name) => name.includes('dz-row-ico')), [...classes].join(','))
check('对话行的动作是图标按钮', classList.some((name) => name.startsWith('dz-icon-btn')), classList.join(','))
check('交接徽标写「交接了几次」', /已交接 \$\{handoffCount\} 次/.test(source))
check(
  '左栏卷宗区可以自己滚',
  source.includes("className: 'dz-side-scroll'") && source.includes('.dz-side-scroll {'),
)

/* 1.0.1：左栏「内容一多就无限拉长、没有滚动条」与卡片标记横向溢出 */
check(
  '左栏行不被压扁（flex 列里的行禁止收缩）',
  /\.dz-side-scroll > \* \{[^}]*flex:0 0 auto/.test(source) && /\.dz-side > \* \{[^}]*flex:0 0 auto/.test(source),
)
check(
  '左栏不再用 100vh 硬算高度',
  !/max-height:calc\(100vh/.test(source),
)
check(
  '面板由父容器定高、内容不把页面撑长',
  /\.dz-page \{[^}]*height:100%[^}]*overflow:hidden/.test(source),
)
check(
  '对话列表在自己的框里滚',
  /\.dz-list \{[^}]*overflow-y:auto/.test(source) && /\.dz-main \{[^}]*max-height:100%/.test(source),
)
check(
  '卡片标记行不换行、超出即裁',
  /\.dz-row-tags \{[^}]*overflow:hidden[^}]*flex-wrap:nowrap/.test(source),
)
check(
  '超长卷宗名用省略号收口（两个标记都接上）',
  /\.dz-tag-name \{[^}]*text-overflow:ellipsis/.test(source) &&
    (source.match(/className: 'dz-tag-name'/g) || []).length === 2,
)
check(
  '标记整体不超出卡片宽度',
  /\.dz-tag \{[^}]*max-width:100%/.test(source) && /\.dz-tag\.is-folder \{ flex:0 1 auto/.test(source),
)
check(
  '左栏不再 sticky，高度贴住父容器',
  /\.dz-side \{[^}]*max-height:100%/.test(source) && !/\.dz-side \{[^}]*position:sticky/.test(source),
)
check(
  '左栏算上 padding 也不超出父容器',
  /\.dz-side \{[^}]*box-sizing:border-box/.test(source),
)
check(
  '交接文档的「未归档」是左栏缩进的独立入口',
  source.includes("sideRow(\n          'docLoose',") && source.includes("kind: 'docLoose'"),
)
check('交接文档页不再混入未归档分组', !source.includes("groupBlock({ files: docs.loose }"))
check('交接文档行能被定位高亮', source.includes("'data-doc-path': file.path") && source.includes('.dz-doc-file.is-focus'))
check('卷宗能置顶', source.includes("runOp({ op: 'folder.pin'"))
check('对话改名走宿主会话服务', source.includes('sessions.using(id, { source: \'workspaceOperation\' }'))

/* 第 5 轮：交接标记/卷宗标记变成链接、文档行带图标、对话图标换辨识度 */
check('「已交接 N 次」是能点的链接', source.includes('dz-tag-link') && source.includes('function openHandoffs'))
check('交接标记不再挂一个右箭头', !source.includes('dz-tag-arrow'))
check('好几份交接文档时给下拉挑选', source.includes('function handoffDocsOf') && source.includes('function jumpToDoc') && source.includes('hoPanel'))
check('卷宗标记能跳到那个卷宗', source.includes('function openFolderPage'))
check('未归档的文档行前面有图标', (source.match(/className: 'dz-doc-ico'/g) || []).length >= 2)
check('对话图标改成圆角气泡（跟文件夹区分开）', source.includes('M3 9.2V6.4a2.2 2.2 0 0 1 2.2-2.2') && !source.includes('M2.8 4.3h10.4v6.5H7.4L5 13.2v-2.4H2.8z'))
check('导入会报告「接回了几条对话的定位」', source.includes('条对话的「定位」接回来了'))
check('交接文档按对话当前归属分组', source.includes('function docsViewOf'))
check('对话没了的文档标出来并收进未归档', source.includes('关联对话已删除'))
check(
  '文档行显示对话当前名字',
  source.includes('dz-doc-owner') && source.includes('.dz-doc-owner {'),
)

/* 第 6 轮：勾选框不显示（定位基准缺失）、用交接文档开新对话 */
check(
  '文档行是勾选框的定位基准',
  /\.dz-doc-file \{[^}]*position:relative/.test(source),
  (source.match(/\.dz-doc-file \{[^}]*\}/) || [''])[0],
)
check('每份文档能单独开新对话', source.includes('用这份交接文档开一个新对话') && source.includes('startChatWithDocs([file.path])'))
check('成组勾选后能开新对话', source.includes('份开新对话') && source.includes('startChatWithDocs(targets)'))
check(
  '新对话会先读交接文档',
  source.includes('async function newChatWithDocs') &&
    source.includes('sessions.create(cwd ? { cwd } : {})') &&
    source.includes("session.prompt([{ type: 'text', text }], 'queue')"),
)
check('交接没投递成功会报错', source.includes('交接文档没发进新对话'))
check('交接文档页头部也有逐份勾选', source.includes("key: 'pick-docs'") && source.includes('逐份勾选：勾好几份后一起导出'))
check('未归档页勾选后出现批量条', source.includes('已勾选 ${loosePicked.length} 份'))

/* 第 7 轮：开新对话先问一句、弹窗改成系统模态框那种规矩、交接按钮重画 */
check('开新对话前先确认', source.includes('份交接文档开一个新对话？') && source.includes("'开新对话',"))
check(
  '点空白不关窗，只抖一下',
  source.includes('setDialogShake((tick) => tick + 1)') &&
    !source.includes("className: 'dz-overlay', onClick: () => setConfirmAsk(null)"),
)
check('Esc 等于取消', source.includes("event.key === 'Escape'") && source.includes('setConfirmAsk(null)'))
check('危险按钮不再铺一整块红', source.includes('is-danger-soft') && !source.includes('is-danger-solid'))
check('归入/挑文档的浮层点外面也只抖', (source.match(/setMenuShake\(\(tick\) => tick \+ 1\)/g) || []).length >= 2)
check('交接按钮重画成胶囊', source.includes('.dz-hb {') && source.includes('生成中…'))
check('交接按钮只剩图标和两个字，没有「交接文档」小字', !source.includes('dz-hb-hint'))
check(
  '生成时文字变绿、完成后回到正文色',
  /\.dz-hb\.is-busy \{[^}]*color:var\(--dsw-alias-state-success-primary\)/.test(source) &&
    /\.dz-hb\.is-ok \{[^}]*color:var\(--dsw-alias-label-primary\)/.test(source),
)

/* 第 10 轮：图标换成一套圆头细线 */
check('图标只剩一套 GLYPHS（不再有 A/B/C 三套）', source.includes('const GLYPHS = {') && !source.includes('ICON_SET') && !source.includes('GLYPH_SETS'))
check('图标统一 16 网格、1.5 圆头描边', source.includes("viewBox: '0 0 16 16'") && source.includes("strokeWidth: '1.5'") && source.includes("strokeLinecap: 'round'") && source.includes("strokeLinejoin: 'round'"))
check('侧栏图标换成档案盒', source.includes('M2.8 5.1h18.4v3.2H2.8z'))

/* 第 9 轮：空对话的拒绝是「状态」不是「失败」，按钮不能劝人重试 */
check('错误对象带得住 code', source.includes('error.code = String(body.code)'))
check('空对话单独成一个状态', source.includes("code === 'empty-session' ? 'empty' : 'error'") && source.includes('无可交接'))
check('空对话不显示「重试」', source.indexOf("? '无可交接'") > 0 && source.indexOf("? '重试'") > source.indexOf("? '无可交接'"))

const icon = registered.find((item) => item.options.name === 'sidebar.panellist')
const iconTree = render(icon.component, { size: 18, active: true })
check('图标渲染出 svg', iconTree && iconTree.type === 'svg')
check('图标按 size 渲染', iconTree && iconTree.props.width === 18, iconTree && iconTree.props.width)

const buttonSlot = registered.find((item) => item.options.name === 'conversation.input.left')
const slotTree = render(buttonSlot.component, { sessionId: 's-1' })
check('交接槽渲染出 span', slotTree && slotTree.type === 'span')

/* ------------------------------------------------ 汇总 */
console.log('')
if (failures) {
  console.log(`FAIL ${failures} 项未通过（通过 ${passes} 项）`)
  process.exitCode = 1
} else {
  console.log(`PASS ${passes} 项断言全部通过`)
}
