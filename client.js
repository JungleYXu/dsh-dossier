/**
 * 卷宗 / dsh-dossier — client half.
 *
 * 三处 UI：
 *  1. main（keyed，key='dossier'）：整页卷宗面板
 *  2. sidebar.panellist（id='dossier'）：侧栏图标
 *  3. conversation.input.left：对话框里的「交接」按钮
 *
 * 数据：全部走宿主插件的 HTTP 接口（GET /dsh-dossier/state、POST /dsh-dossier/op、
 * POST /dsh-dossier/handoff），会话列表从 ctx.sessions.list 读。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dossier',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const BASE = '/dsh-dossier'
    const PANEL_KEY = 'dossier'

    let ctxRef = null

    /* ------------------------------------------------------------ 小工具 */

    function messageOf(error) {
      if (!error) return '未知错误'
      return String(error.message || error.error || error)
    }

    function pad(n) {
      return String(n).padStart(2, '0')
    }

    function relTime(ms) {
      const value = Number(ms) || 0
      if (!value) return ''
      const diff = Date.now() - value
      if (diff < 45_000) return '刚刚'
      if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
      if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
      const d = new Date(value)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }

    async function readJson(response) {
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || (body && body.ok === false)) {
        const error = new Error((body && body.error) || `HTTP ${response.status}`)
        // 宿主用 code 区分「状态不满足」（如空对话）与真正的失败，客户端要能分开显示。
        if (body && body.code) error.code = String(body.code)
        throw error
      }
      return body || {}
    }

    function postJson(url, payload) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      }).then(readJson)
    }

    /* ------------------------------------------------ 会话/工作区快照胶水 */

    const EMPTY_SESSIONS = { ids: [], byId: {}, phase: 'pending' }
    const EMPTY_WORKSPACES = { archivedSessionIds: [], phase: 'pending' }

    function bindList(resolveSource, fallback) {
      let value = null
      let attached = false
      const subs = new Set()

      function read() {
        const source = resolveSource()
        if (!source || typeof source.getSnapshot !== 'function') return null
        if (!attached && typeof source.subscribe === 'function') {
          attached = true
          try {
            source.subscribe(() => {
              read()
              for (const fn of Array.from(subs)) fn()
            })
          } catch {
            /* 订阅失败就退化成一次性读取 */
          }
        }
        try {
          value = source.getSnapshot()
        } catch {
          value = null
        }
        return value
      }

      return {
        get value() {
          if (value == null) read()
          return value || fallback
        },
        subscribe(fn) {
          subs.add(fn)
          read()
          fn()
          return () => {
            subs.delete(fn)
          }
        },
      }
    }

    const sessionList = bindList(() => (ctxRef && ctxRef.sessions && ctxRef.sessions.list) || null, EMPTY_SESSIONS)
    const workspaceList = bindList(
      () => (ctxRef && ctxRef.workspaces && ctxRef.workspaces.list) || null,
      EMPTY_WORKSPACES,
    )

    function useGlue(glue) {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => glue.subscribe(force), [])
      return glue.value
    }

    /* -------------------------------------------------------- 卷宗数据层 */

    const EMPTY_PATHS = { cwd: '', handoffRoot: '', backupRoot: '', store: '' }
    let dstate = { phase: 'idle', folders: [], entries: [], handoffs: {}, paths: EMPTY_PATHS, error: '' }
    let viewSessionId = ''
    const dsubs = new Set()

    /* 列表显示方式：卡片网格 / 单列列表。存在浏览器本地，跟机器走，不动服务端数据。 */
    const VIEW_KEY = 'dsh-dossier:view'

    function readView() {
      try {
        const raw = typeof localStorage === 'undefined' ? '' : localStorage.getItem(VIEW_KEY)
        return raw === 'list' ? 'list' : 'grid'
      } catch (error) {
        return 'grid'
      }
    }

    function saveView(mode) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, mode)
      } catch (error) {
        /* 隐私模式下写不进去就只留在内存里 */
      }
    }

    /* 不属于任何卷宗的列表（全部对话 / 未归档）没有手动顺序，只有时间与名称两种排序 */
    const SORT_KEY = 'dsh-dossier:sort'

    function readSort() {
      try {
        const raw = typeof localStorage === 'undefined' ? '' : localStorage.getItem(SORT_KEY)
        return raw === 'name' ? 'name' : 'time'
      } catch (error) {
        return 'time'
      }
    }

    function saveSort(mode) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_KEY, mode)
      } catch (error) {
        /* 同上 */
      }
    }

    /* 卷宗列表自身的排序：默认（手动顺序）/ 时间 / 名称。左栏永远按手动顺序。 */
    const FOLDERS_SORT_KEY = 'dsh-dossier:folders-sort'

    function readFoldersSort() {
      try {
        const raw = typeof localStorage === 'undefined' ? '' : localStorage.getItem(FOLDERS_SORT_KEY)
        return raw === 'name' || raw === 'time' ? raw : 'manual'
      } catch (error) {
        return 'manual'
      }
    }

    function saveFoldersSort(mode) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(FOLDERS_SORT_KEY, mode)
      } catch (error) {
        /* 同上 */
      }
    }

    function dSet(patch) {
      dstate = { ...dstate, ...patch }
      for (const fn of Array.from(dsubs)) fn()
    }

    function adoptState(body) {
      dSet({
        phase: 'ready',
        folders: Array.isArray(body.folders) ? body.folders : [],
        entries: Array.isArray(body.entries) ? body.entries : [],
        handoffs: body.handoffs && typeof body.handoffs === 'object' ? body.handoffs : {},
        paths: body.paths && typeof body.paths === 'object' ? body.paths : EMPTY_PATHS,
        error: '',
      })
    }

    let inflight = null
    function loadDossier(sessionId) {
      if (inflight) return inflight
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      inflight = fetch(`${BASE}/state${query}`, { headers: { accept: 'application/json' } })
        .then(readJson)
        .then((body) => {
          adoptState(body)
          return body
        })
        .catch((error) => {
          dSet({ phase: 'error', error: messageOf(error) })
        })
        .then(() => {
          inflight = null
        })
      return inflight
    }

    function runOp(payload) {
      return postJson(`${BASE}/op`, { ...payload, viewSessionId }).then((body) => {
        adoptState(body)
        return body
      })
    }

    function useDossier() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        dsubs.add(force)
        return () => {
          dsubs.delete(force)
        }
      }, [])
      return dstate
    }

    /* -------------------------------------------------------- 用量与费用 */

    let ustate = { sessionId: '', phase: 'idle', data: null }
    const usubs = new Set()

    function uSet(patch) {
      ustate = { ...ustate, ...patch }
      for (const fn of Array.from(usubs)) fn()
    }

    function loadUsage(sessionId) {
      if (!sessionId) {
        uSet({ sessionId: '', phase: 'ready', data: null })
        return Promise.resolve(null)
      }
      if (ustate.sessionId === sessionId && ustate.phase === 'ready') return Promise.resolve(ustate.data)
      if (ustate.sessionId !== sessionId) uSet({ sessionId, phase: 'loading', data: null })
      return fetch(`${BASE}/usage?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { accept: 'application/json' },
      })
        .then(readJson)
        .then((body) => {
          uSet({ sessionId, phase: 'ready', data: body })
          return body
        })
        .catch(() => {
          uSet({ sessionId, phase: 'error', data: null })
        })
    }

    function useUsage() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        usubs.add(force)
        return () => {
          usubs.delete(force)
        }
      }, [])
      return ustate
    }

    function shortNum(value) {
      const n = Number(value) || 0
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
      if (n >= 10_000) return `${(n / 10000).toFixed(1)}万`
      return String(Math.round(n))
    }

    function money(value) {
      const n = Number(value) || 0
      if (!n) return '¥0'
      if (n < 0.01) return `¥${n.toFixed(4)}`
      if (n < 1) return `¥${n.toFixed(3)}`
      return `¥${n.toFixed(2)}`
    }

    /* --------------------------------------------------------- 文档图标 */

    /*
     * 全部图标走同一套线条：16×16 网格、1.5 描边、圆头圆角、只描边不填色
     * （只有聊天气泡里的三个点、定位的圆心用实心，缩到 14px 也认得出来）。
     * 不用 ⤓ ✕ ⌖ ☑ 这些字符 —— 字符在不同字体里基线、粗细都不一样，看起来就脏。
     */
    const GLYPHS = {
      folder: {
        stroke: ['M2.6 5.2a1 1 0 0 1 1-1h3l1.6 2h4.2a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1z'],
      },
      doc: {
        stroke: ['M4.6 2.6h4.1l2.7 2.7v8.1H4.6z', 'M8.7 2.7v2.7h2.7'],
      },
      chat: {
        stroke: [
          'M3 9.2V6.4a2.2 2.2 0 0 1 2.2-2.2h5.6A2.2 2.2 0 0 1 13 6.4v2.8a2.2 2.2 0 0 1-2.2 2.2H7.4L4.8 13.4v-2A2.2 2.2 0 0 1 3 9.2z',
        ],
        fill: [
          'M5.9 7.05a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
          'M8 7.05a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
          'M10.1 7.05a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
        ],
      },
      pin: {
        stroke: ['M6.4 2.9h3.2l-.5 3.1 1.6 1.8H5.3l1.6-1.8z', 'M8 7.8v5.6'],
      },
      check: {
        stroke: ['M3.4 3.4h9.2v9.2H3.4z', 'M5.7 8.1l1.6 1.7 3.1-3.6'],
      },
      export: {
        stroke: ['M3.2 10.4v2.4h9.6v-2.4', 'M8 3.1v6.4', 'M5.6 5.5L8 3.1l2.4 2.4'],
      },
      import: {
        stroke: ['M3.2 10.4v2.4h9.6v-2.4', 'M8 3.1v6.4', 'M5.6 7.1L8 9.5l2.4-2.4'],
      },
      del: {
        stroke: ['M3.3 4.7h9.4', 'M6.5 4.7V3.2h3v1.5', 'M4.9 4.7l.6 8.1h5l.6-8.1'],
      },
      locate: {
        stroke: [
          'M8 4.9a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z',
          'M8 1.9v2.1',
          'M8 12v2.1',
          'M1.9 8h2.1',
          'M12 8h2.1',
        ],
        fill: ['M8 7.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z'],
      },
      edit: {
        stroke: ['M3 13l3.3-.6 6.8-6.8-2.7-2.7L3.6 9.7z', 'M8.9 3l2.7 2.7'],
      },
      up: {
        stroke: ['M8 12.9V3.3', 'M4.7 6.6L8 3.3l3.3 3.3'],
      },
      down: {
        stroke: ['M8 3.1v9.6', 'M4.7 9.4L8 12.7l3.3-3.3'],
      },
      out: {
        stroke: ['M9.7 3.4h2.7a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H9.7', 'M3 8h7.4', 'M7.8 5.6L10.2 8l-2.4 2.4'],
      },
    }

    function glyph(name) {
      const item = GLYPHS[name]
      if (!item) return null
      const kids = []
      for (const d of item.stroke || []) {
        kids.push(h('path', { key: `s${kids.length}`, d, fill: 'none' }))
      }
      for (const d of item.fill || []) {
        kids.push(h('path', { key: `f${kids.length}`, d, fill: 'currentColor', stroke: 'none' }))
      }
      return h(
        'svg',
        {
          key: 'g',
          className: 'dz-svg',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        kids,
      )
    }

    /* ------------------------------------------------------------- 样式 */

    const CSS = `
.dz-page { box-sizing:border-box; height:100%; min-height:0; overflow:hidden; padding:22px 26px 36px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; display:flex; flex-direction:column; gap:14px; }
.dz-top { flex:0 0 auto; display:flex; flex-direction:column; gap:5px; }
.dz-h1 { margin:0; font-size:18px; font-weight:600; letter-spacing:.02em; display:flex; align-items:baseline; gap:10px; }
.dz-h1 small { font-size:12px; font-weight:400; color:var(--dsw-alias-label-secondary); }
.dz-sub { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.6; overflow-wrap:anywhere; }
.dz-usage { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.6; font-variant-numeric:tabular-nums; }
.dz-sub code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; padding:1px 5px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }
.dz-body { flex:1 1 auto; min-height:0; display:grid; grid-template-columns:236px minmax(0,1fr); gap:16px; align-items:start; }
.dz-side { box-sizing:border-box; flex:none; min-height:0; max-height:100%; overflow:hidden; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:6px; display:flex; flex-direction:column; gap:2px; }
.dz-side-row.is-pinned { background:var(--dsw-alias-bg-layer-2); }
.dz-doc-group { border:1px solid var(--dsw-alias-border-l2); border-radius:9px; background:var(--dsw-alias-bg-layer-1); margin-bottom:8px; overflow:hidden; }
.dz-doc-group.is-open { background:var(--dsw-alias-bg-layer-1); }
.dz-doc-head { display:flex; align-items:center; gap:8px; padding:9px 11px; font-size:13px; cursor:pointer; user-select:none; }
.dz-doc-head:hover { background:var(--dsw-alias-bg-layer-2); }
.dz-doc-caret { width:12px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dz-doc-ico { flex:none; display:inline-flex; color:var(--dsw-alias-label-secondary); }
.dz-doc-title { font-weight:600; }
.dz-doc-count { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dz-doc-batch { margin-left:auto; display:flex; gap:4px; }
.dz-doc-body { border-top:1px solid var(--dsw-alias-border-l1); padding:4px 6px 6px; }
.dz-doc-empty { padding:4px 11px 10px 31px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.dz-doc-note { font-size:11.5px; color:var(--dsw-alias-label-secondary); padding:2px 2px 8px; }
/* position:relative 是给勾选框用的：.dz-check 是绝对定位，定位基准必须在这一行上 */
.dz-doc-file { display:flex; align-items:center; gap:9px; padding:5px 6px 5px 52px; border-radius:6px; font-size:12px; position:relative; }
.dz-doc-file:hover { background:var(--dsw-alias-bg-layer-2); }
.dz-doc-file.is-picked { background:var(--dsw-alias-bg-layer-2); }
.dz-doc-name { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dz-doc-meta { color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; white-space:nowrap; font-size:11px; }
/* 文档行上顺带显示「这是哪条对话的交接」，以及对话已经没了的那种 */
.dz-doc-owner { max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.dz-doc-dead { font-size:10px; color:var(--dsw-alias-label-error); border:1px solid var(--dsw-alias-label-error); border-radius:8px; padding:0 5px; opacity:.85; }
.dz-doc-tools { margin-left:auto; display:flex; gap:3px; }
.dz-mini { height:22px; min-width:22px; padding:0 5px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
.dz-svg { display:block; flex:none; }
.dz-mini:hover { border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); }
.dz-mini.is-on { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dz-mini.is-danger:hover { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dz-side-row { display:flex; align-items:center; gap:6px; height:32px; padding:0 8px; border-radius:7px; cursor:pointer; font-size:13px; user-select:none; color:var(--dsw-alias-label-primary); }
.dz-side-row.is-sub { padding-left:34px; font-size:12.5px; color:var(--dsw-alias-label-secondary); }
.dz-side-row.is-sub.is-active { color:var(--dsw-alias-brand-primary); }
.dz-side-row:hover { background:var(--dsw-alias-bg-layer-2); }
.dz-side-row.is-active { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-brand-primary); font-weight:600; }
.dz-side-label { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dz-side-ico { flex:none; width:14px; display:inline-flex; align-items:center; justify-content:center; opacity:.9; }
.dz-fico { flex:none; display:inline-flex; align-items:center; color:var(--dsw-alias-label-secondary); }
.dz-side-meta { margin-left:auto; font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dz-sep { height:1px; margin:6px 4px; background:var(--dsw-alias-border-l2); }
.dz-side-foot { padding:8px 8px 4px; font-size:11px; color:var(--dsw-alias-label-secondary); line-height:1.65; }
.dz-btn { font:inherit; font-size:12px; height:26px; padding:0 9px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:4px; white-space:nowrap; }
.dz-btn:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.dz-btn.is-on { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dz-btn.is-danger:hover { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dz-btn:disabled { opacity:.45; cursor:default; }
.dz-btn.is-primary { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dz-btn.is-icon { padding:0 6px; }
.dz-icons { display:inline-flex; height:26px; align-items:center; gap:2px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; padding:0 2px; background:var(--dsw-alias-bg-layer-1); }
.dz-icon-btn { width:24px; height:22px; display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:5px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dz-icon-btn:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
.dz-icon-btn.is-on { color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.dz-seg { display:inline-flex; height:26px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; overflow:hidden; background:var(--dsw-alias-bg-layer-1); }
.dz-seg-btn { font:inherit; font-size:12px; padding:0 9px; border:0; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; white-space:nowrap; }
.dz-seg-btn:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
.dz-seg-btn.is-on { color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); font-weight:600; box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.dz-btn.dz-block { width:100%; justify-content:flex-start; }
.dz-main { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; min-height:340px; overflow:hidden; }
.dz-main-head { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:0 13px; height:52px; border-bottom:1px solid var(--dsw-alias-border-l2); flex-wrap:nowrap; }
.dz-main-head > div:first-child { min-width:0; flex:1 1 auto; }
.dz-main-title { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dz-main-sub { font-size:11.5px; color:var(--dsw-alias-label-secondary); margin-top:2px; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dz-head-actions { margin-left:auto; display:flex; gap:6px; align-items:center; flex-wrap:nowrap; flex:0 0 auto; }
.dz-list { padding:6px; display:flex; flex-direction:column; gap:1px; }
.dz-list.is-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(176px,1fr)); gap:6px; padding:8px; align-content:start; }
.dz-cell { display:flex; flex-direction:column; min-width:0; }
.dz-row { position:relative; display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:8px; min-height:38px; }
.dz-check { position:absolute; left:7px; top:50%; transform:translateY(-50%); width:13px; height:13px; border:1px solid var(--dsw-alias-border-l2); border-radius:3px; background:var(--dsw-alias-bg-base); display:inline-flex; align-items:center; justify-content:center; }
.dz-check.is-on { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dz-check.is-on::after { content:'✓'; color:#fff; font-size:10px; font-weight:700; line-height:1; }
.dz-row.is-picked { border-color:var(--dsw-alias-brand-primary) !important; background:var(--dsw-alias-bg-layer-2) !important; }
.dz-pick-count { font-size:11.5px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dz-row:hover { background:var(--dsw-alias-bg-layer-2); }
.dz-row-main { flex:1 1 auto; min-width:0; cursor:pointer; display:flex; flex-direction:column; gap:3px; }
.dz-row-line { display:flex; align-items:center; gap:6px; min-width:0; }
.dz-row-title { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dz-tag-tight { font-size:10px; padding:0 5px; line-height:16px; }
.dz-row.is-focus { border-color:var(--dsw-alias-brand-primary) !important; background:var(--dsw-alias-bg-layer-2) !important; }
.dz-row.is-pinned .dz-row-title::before { content:'📌'; font-size:10px; margin-right:4px; }
.dz-row-actions.is-visible { opacity:1; }
.dz-row-meta { font-size:11px; color:var(--dsw-alias-label-secondary); display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.dz-row-actions { display:flex; gap:4px; opacity:0; transition:opacity .12s ease; }
.dz-row:hover .dz-row-actions { opacity:1; }
.dz-list.is-grid .dz-row { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); border-radius:9px; padding:6px 9px; min-height:0; align-items:flex-start; }
.dz-list:not(.is-grid) { gap:0; padding:4px 6px; }
.dz-list:not(.is-grid) .dz-row { border:1px solid transparent; border-radius:6px; padding:3px 9px; min-height:28px; }
.dz-list:not(.is-grid) .dz-cell + .dz-cell { border-top:1px solid var(--dsw-alias-border-l2); }
.dz-list:not(.is-grid) .dz-row-main { flex-direction:row; align-items:center; gap:10px; }
.dz-list:not(.is-grid) .dz-row-line { flex:1 1 auto; min-width:0; }
.dz-list:not(.is-grid) .dz-row-title { font-size:12.5px; }
.dz-list:not(.is-grid) .dz-row-meta { margin-left:auto; flex:0 0 auto; }
.dz-list:not(.is-grid) .dz-row:hover { border-color:var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
.dz-list.is-grid .dz-row:hover { border-color:var(--dsw-alias-border-l2); }
.dz-list.is-grid .dz-row-title { white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.35; font-size:12.5px; }
.dz-list.is-grid .dz-fico { font-size:17px; }
.dz-list.is-grid .dz-row-main { gap:5px; }
.dz-list.is-grid .dz-row-meta { font-size:10.5px; gap:4px; }
.dz-list.is-grid .dz-tag { font-size:10px; padding:0 4px; }
.dz-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary); flex:none; }
.dz-dot.is-soft { opacity:.4; }
.dz-live { display:inline-flex; align-items:center; gap:4px; color:var(--dsw-alias-state-success-primary); white-space:nowrap; }
/* 选中对话那一行：这条对话值多少钱、缓存还热不热 */
.dz-usage.is-sel { display:flex; align-items:center; gap:8px; color:var(--dsw-alias-label-primary); }
.dz-state { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; font-weight:600; }
.dz-state.is-warm { color:var(--dsw-alias-state-success-primary); }
.dz-state.is-broken { color:var(--dsw-alias-state-warn-primary); }
.dz-state.is-broken .dz-dot { background:var(--dsw-alias-state-warn-primary); }
.dz-tag { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; font-size:10.5px; padding:1px 6px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
/* 标记里的文字自己收口：卷宗名可以很长，卡片只有 176px 起，不能让标记顶出卡片边框 */
.dz-tag-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dz-tag.is-brand { flex:0 0 auto; color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dz-tag.is-folder { flex:0 1 auto; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); font-weight:600; }
/* 标记本身也是按钮：默认是标签的样子，鼠标移上去才露出「可以点」 */
.dz-tag-link { border:1px solid var(--dsw-alias-border-l1); background:transparent; font:inherit; font-size:10.5px; line-height:16px; cursor:pointer; padding:0 6px; }
.dz-tag.is-brand.dz-tag-link { border-color:var(--dsw-alias-brand-primary); }
.dz-tag.is-folder.dz-tag-link { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.dz-tag-link:hover { text-decoration:underline; }
.dz-tag-link:disabled { cursor:default; text-decoration:none; }
.dz-tag-caret { font-size:9px; opacity:.72; }
.dz-row-hint { flex:none; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; font-size:10.5px; padding:1px 7px; border-radius:9px; white-space:nowrap; color:var(--dsw-alias-state-warn-primary); border:1px solid var(--dsw-alias-state-warn-primary); }
/* 五角星是唯一一处不用主题色：交接文档要一眼找到，主题里没有"黄" */
.dz-star { color:#e8a300; font-size:13px; }
/* 卡片固定四行：标题 / 标记 / 「已在某卷宗」/ 时间；中间两行永远占位，所以卡片高度不跳 */
.dz-row-blank { display:inline-block; min-height:10px; }
/* 卡片第二、三行：标记行不换行、超长收口；「已在某卷宗」那句也一样，不许顶出卡片 */
.dz-row-tags { min-height:16px; min-width:0; overflow:hidden; flex-wrap:nowrap; }
.dz-row-hintline { min-height:14px; min-width:0; overflow:hidden; }
.dz-list.is-grid .dz-row-main { gap:1px; }
.dz-list.is-grid .dz-row-when { margin-top:auto; }
/* 卡片里操作按钮绝对定位到右下角，否则它会挤掉标题的宽度让标题换行 */
.dz-list.is-grid .dz-row { position:relative; }
.dz-list.is-grid .dz-row-actions { position:absolute; right:7px; bottom:5px; padding-left:6px; border-radius:6px; background:inherit; }
.dz-list.is-grid .dz-row:hover .dz-row-actions { background:inherit; }
.dz-empty { padding:34px 16px; text-align:center; font-size:12.5px; color:var(--dsw-alias-label-secondary); line-height:1.9; }
.dz-err { margin:0 8px 8px; padding:8px 10px; border-radius:8px; font-size:11.5px; color:var(--dsw-alias-state-error-primary); border:1px solid var(--dsw-alias-state-error-primary); line-height:1.6; }
/* 弹窗：遮罩只用一点点暗，不做成「偏红的一大片」；点空白不关，只抖一下（像 Windows 的模态框） */
.dz-overlay { position:fixed; inset:0; z-index:1200; background:rgba(0,0,0,.18); display:flex; align-items:center; justify-content:center; }
.dz-overlay.is-menu { align-items:flex-start; justify-content:flex-end; padding:184px 34px 0 0; background:rgba(0,0,0,.1); }
.dz-menu { width:min(296px,86vw); max-height:62vh; overflow:auto; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; box-shadow:0 16px 36px rgba(0,0,0,.22); padding:8px; }
.dz-menu.is-shake { animation:dz-shake .38s cubic-bezier(.36,.07,.19,.97); }
.dz-menu-head { font-size:11px; color:var(--dsw-alias-label-secondary); padding:4px 9px 8px; }
.dz-menu-warn { font-size:11px; color:var(--dsw-alias-state-warn-primary); padding:0 9px 8px; line-height:1.5; }
.dz-menu-empty { font-size:11.5px; color:var(--dsw-alias-label-secondary); padding:6px 9px 10px; line-height:1.6; }
.dz-menu-sep { height:1px; margin:6px 4px; background:var(--dsw-alias-border-l1); }
.dz-menu-item { display:flex; align-items:center; gap:8px; width:100%; text-align:left; font:inherit; font-size:12.5px; padding:8px 9px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-primary); cursor:pointer; }
.dz-menu-item:hover { background:var(--dsw-alias-bg-layer-2); }
.dz-menu-ico { flex:none; display:inline-flex; align-items:center; opacity:.9; }
.dz-menu-name { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dz-menu-count { flex:none; font-size:10.5px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.dz-menu-item.is-cancel { color:var(--dsw-alias-label-secondary); justify-content:center; }
.dz-menu-item.is-add { color:var(--dsw-alias-brand-primary); }
.dz-menu-plus { color:var(--dsw-alias-brand-primary); font-weight:700; }
.dz-menu-newrow { display:flex; gap:6px; align-items:center; padding:2px 4px 8px; }
.dz-menu-newrow .dz-input { height:26px; font-size:12px; }
.dz-dialog { width:min(420px,90vw); background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:12px; box-shadow:0 18px 40px rgba(0,0,0,.26); padding:16px 18px 14px; }
.dz-dialog.is-shake { animation:dz-shake .38s cubic-bezier(.36,.07,.19,.97); }
@keyframes dz-shake {
  10%, 90% { transform:translateX(-2px); }
  20%, 80% { transform:translateX(3px); }
  30%, 50%, 70% { transform:translateX(-5px); }
  40%, 60% { transform:translateX(5px); }
}
.dz-dialog-hint { font-size:11px; color:var(--dsw-alias-label-secondary); opacity:.75; margin-top:10px; }
.dz-dialog-title { font-size:14px; font-weight:600; margin-bottom:8px; }
.dz-dialog-line { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.75; }
.dz-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
/* 危险操作只染字和边框，不铺一整块红 */
.dz-btn.is-danger-soft { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dz-btn.is-danger-soft:hover { color:#fff; background:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dz-input { box-sizing:border-box; font:inherit; font-size:13px; height:30px; padding:0 9px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); outline:none; width:100%; }
.dz-input:focus { border-color:var(--dsw-alias-brand-primary); }
/* 交接按钮：胶囊形，跟输入框边上那些控件一个体量；点一下会往当前对话发一条短消息 */
.dz-hb { font:inherit; font-size:12px; height:28px; padding:0 10px 0 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-primary); cursor:pointer; display:inline-flex; align-items:center; gap:6px; transition:color .12s, border-color .12s, background .12s; }
.dz-hb:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dz-hb:active { transform:translateY(.5px); }
.dz-hb.is-busy { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); border-style:dashed; }
.dz-hb.is-ok { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-state-success-primary); }
.dz-hb.is-err { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dz-hb:disabled { opacity:.7; cursor:default; }
.dz-hb:disabled:hover { background:transparent; }
.dz-hb-text { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; letter-spacing:.02em; }
.dz-hb-ico { display:inline-flex; align-items:center; opacity:.85; }

/* 左栏 / 主列表都限高自己滚：卷宗和对话只会越用越多，不能把整页一直往下拉长。
   高度不再用 100vh 算 —— 页面是面板里的 flex 列（.dz-page 高 100%），中间那行 flex:1，
   左右两栏各占这一行的整高，框内自己滚。这样窗口多高、面板被什么包着都不会算错。 */
.dz-side-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; scrollbar-gutter:stable; display:flex; flex-direction:column; gap:2px; padding-right:2px; }
/* 关键：卷宗行不许被压扁。少了这句，行会在 flex 列里收缩（32px 压到 23px），
   于是「行数变多」表现为行越来越矮、而不是出现滚动条 —— 就是「左栏不滚」那个现象。 */
.dz-side-scroll > * { flex:0 0 auto; }
/* 同一个坑在外层也有一次：左栏自己也是 flex 列，顶部那几行（交接文档 / 未归档 / 全部对话）
   在内容超高时同样会被压扁（32px → 22px），所以除滚动区之外的子项一律不收缩。 */
.dz-side > * { flex:0 0 auto; }
.dz-side > .dz-side-scroll { flex:1 1 auto; }
.dz-side-foot { flex:0 0 auto; }
.dz-main { align-self:stretch; max-height:100%; }
.dz-list { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
/* 滚动条要看得见：原来的 8px 浅灰在浅底上几乎等于没有，加宽到 10px 并给 thumb 圆角 */
.dz-side-scroll::-webkit-scrollbar, .dz-list::-webkit-scrollbar { width:10px; height:10px; }
.dz-side-scroll::-webkit-scrollbar-thumb, .dz-list::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l2); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); border-radius:5px; border:2px solid transparent; background-clip:padding-box; }
.dz-side-scroll::-webkit-scrollbar-thumb:hover, .dz-list::-webkit-scrollbar-thumb:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 65%, transparent); background-clip:padding-box; }
.dz-side-scroll::-webkit-scrollbar-track, .dz-list::-webkit-scrollbar-track { background:transparent; }
/* 对话前面的小图标：一眼区分「这是对话」而不是卷宗 */
.dz-row-ico { flex:none; display:inline-flex; align-items:center; color:var(--dsw-alias-label-secondary); }
.dz-row-actions .dz-icon-btn { width:20px; height:20px; }
.dz-row-actions { align-items:center; }
/* 对话改名：行内输入框直接顶替标题，回车保存、Esc 放弃 */
.dz-row-edit { flex:1 1 auto; min-width:0; }
.dz-row-edit .dz-input { height:24px; font-size:12.5px; }
/* 从对话「定位交接文档」时，那一份要能一眼看到 */
.dz-doc-file.is-focus { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:-1px; background:var(--dsw-alias-bg-layer-2); }
.dz-doc-origin { font-size:10px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:0 5px; }
/* 「未归档」另起一行、缩进两格：它不是卷宗，只是没归入卷宗的那些文档 */
.dz-doc-head.is-sub { padding-left:24px; }
.dz-doc-head.is-sub .dz-doc-title { color:var(--dsw-alias-label-secondary); }
/* 勾选后的批量条不是可展开的组头，别给成手指光标 */
.dz-doc-head.is-strip { cursor:default; padding:4px 11px 6px; font-size:12px; }
.dz-icon-btn.is-danger:hover { color:var(--dsw-alias-label-error); border-color:var(--dsw-alias-label-error); }

/* 多选：必须放在最后，否则会被上面的「列表/卡片」模式样式覆盖掉左内边距 */
.dz-list.is-picking .dz-row { padding-left:26px; }
`

    /* ------------------------------------------------------------- 图标 */

    function DossierIcon(props) {
      const raw = props && Number(props.size)
      const size = raw > 0 ? raw : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M3.6 8.3h16.8v9.2a1.4 1.4 0 0 1-1.4 1.4H5a1.4 1.4 0 0 1-1.4-1.4z' }),
        h('path', { d: 'M2.8 5.1h18.4v3.2H2.8z' }),
        h('path', { d: 'M9.4 12.8h5.2' }),
      )
    }

    /* ------------------------------------------------------------- 面板 */

    function DossierPage() {
      const dossier = useDossier()
      const usage = useUsage()
      const sessions = useGlue(sessionList)
      const workspaces = useGlue(workspaceList)

      const [selection, setSelection] = React.useState({ kind: 'loose', id: '' })
      const [view, setView] = React.useState(readView)
      const [looseSort, setLooseSort] = React.useState(readSort)
      const [creating, setCreating] = React.useState(false)
      const [draftName, setDraftName] = React.useState('')
      const [renaming, setRenaming] = React.useState(null)
      const [picking, setPicking] = React.useState(false)
      const [picked, setPicked] = React.useState([])
      const [assignOpen, setAssignOpen] = React.useState(false)
      const [folderViewSort, setFolderViewSort] = React.useState(readFoldersSort)
      const [confirmAsk, setConfirmAsk] = React.useState(null)
      const [dialogShake, setDialogShake] = React.useState(0)
      const [menuShake, setMenuShake] = React.useState(0)
      const [assignNew, setAssignNew] = React.useState('')
      const [creatingInMenu, setCreatingInMenu] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [focused, setFocused] = React.useState('')
      // 交接文档视图：默认全部收起，一次展开一个；展开后可对这一组做批量导出/删除
      const [docOpen, setDocOpen] = React.useState('')
      const [docPicking, setDocPicking] = React.useState(false)
      const [docPicked, setDocPicked] = React.useState([])
      const [docNote, setDocNote] = React.useState('')
      // 从对话「定位」到交接文档：先记下要跳到哪一份，等 docs 读完再展开并高亮
      const [docJump, setDocJump] = React.useState('')
      const [docFocus, setDocFocus] = React.useState('')
      // 「已交接 N 次」点开的清单：一条对话可能有好几份交接文档，得让用户挑一份跳
      const [hoMenu, setHoMenu] = React.useState('')
      // 行内改对话名：只记一条（同时只能改一个）
      const [renamingSession, setRenamingSession] = React.useState(null)
      // 选中某条对话时，单独查它的用量：步数 / 上下文 / 冷启动价 / 缓存还在不在
      const [selUse, setSelUse] = React.useState({ id: '', phase: 'idle', data: null })
      const bundleInput = React.useRef(null)

      const ids = (sessions && sessions.ids) || []
      const byId = (sessions && sessions.byId) || {}
      const archived = new Set((workspaces && workspaces.archivedSessionIds) || [])

      // 面板是 root 作用域、没有 sessionId，但交接目录要落在某个工作区里：
      // 用最近更新过的那个会话当「视角」，宿主据此解析 cwd。
      let newestId = ''
      let newestAt = -1
      for (const id of ids) {
        const meta = byId[id]
        if (!meta || archived.has(id) || meta.parentSessionId || meta.origin === 'subagent') continue
        const at = Number(meta.updatedAt) || 0
        if (at > newestAt) {
          newestAt = at
          newestId = id
        }
      }

      React.useEffect(() => {
        viewSessionId = newestId
        loadDossier(newestId)
        loadUsage(newestId)
      }, [newestId])

      // 相对时间每分钟重算
      const [, tick] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        const timer = setInterval(tick, 60_000)
        return () => clearInterval(timer)
      }, [])
      const folders = dossier.folders
      const folderById = {}
      for (const folder of folders) folderById[folder.id] = folder
      const entryOf = {}
      for (const entry of dossier.entries) entryOf[entry.sessionId] = entry

      // 选中的卷宗被删掉时退回「未归档」，但不在渲染过程中改 state
      const sel = selection.kind === 'folder' && !folderById[selection.id] ? { kind: 'loose', id: '' } : selection

      // 换视图时把「选择」状态整组清掉：每个视图有各自的勾选，不能带着上一个视图的越界状态进来
      React.useEffect(() => {
        setFocused('')
        setPicking(false)
        setPicked([])
        setAssignOpen(false)
        setCreatingInMenu(false)
        setAssignNew('')
        setRenamingSession(null)
        setDocPicking(false)
        setDocPicked([])
        // 进「交接文档」可能是从某条对话定位过来的，这时要保留它指定的展开项与高亮项
        if (sel.kind !== 'docs' && sel.kind !== 'docLoose') {
          setDocOpen('')
          setDocFocus('')
          setDocJump('')
          setDocNote('')
        }
      }, [sel.kind, sel.id])

      // 交接文档目录：置顶的一项，列出 <工作区>/goals/ 下的卷宗子文件夹与散装文档
      const [docs, setDocs] = React.useState(null)
      const [docsError, setDocsError] = React.useState('')
      const loadDocs = React.useCallback(() => {
        const query = viewSessionId ? `?sessionId=${encodeURIComponent(viewSessionId)}` : ''
        fetch(`${BASE}/docs${query}`, { headers: { accept: 'application/json' } })
          .then(readJson)
          .then((body) => {
            if (body && body.ok) {
              setDocs(body)
              setDocsError('')
            } else {
              setDocsError((body && body.error) || '读取交接文档目录失败')
            }
          })
          .catch((error) => setDocsError(messageOf(error)))
      }, [])

      React.useEffect(() => {
        if (newestId) loadDocs()
      }, [newestId])

      // 定位：docs 读到了再切到目标文档所在的页，位置由下面那个 effect 滚过去
      React.useEffect(() => {
        if (!docJump || !docs) return
        const view = docsViewOf(docs)
        const inFolder = view.folders.find((group) => (group.files || []).some((file) => file.path === docJump))
        const inLoose = view.loose.some((file) => file.path === docJump)
        setDocFocus(docJump)
        setDocJump('')
        if (inFolder) {
          setDocOpen(inFolder.key)
          setSelection({ kind: 'docs', id: '' })
        } else if (inLoose) {
          setDocOpen('')
          setSelection({ kind: 'docLoose', id: '' })
        } else {
          setDocOpen('')
          setDocNote('还没读到这份交接文档，稍后再点一次。')
        }
      }, [docJump, docs])

      React.useEffect(() => {
        if (!docFocus || typeof document === 'undefined') return
        const nodes = document.querySelectorAll('[data-doc-path]')
        for (const node of nodes) {
          if (node.getAttribute('data-doc-path') !== docFocus) continue
          if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' })
          break
        }
      }, [docFocus, docOpen])

      // 选中对话的用量：模糊点名就查一次，冷会话由宿主去读盘
      React.useEffect(() => {
        if (!focused) {
          setSelUse({ id: '', phase: 'idle', data: null })
          return undefined
        }
        let alive = true
        setSelUse({ id: focused, phase: 'loading', data: null })
        fetch(`${BASE}/usage?sessionId=${encodeURIComponent(focused)}`, { headers: { accept: 'application/json' } })
          .then(readJson)
          .then((body) => {
            if (alive) setSelUse({ id: focused, phase: 'ready', data: body })
          })
          .catch(() => {
            if (alive) setSelUse({ id: focused, phase: 'error', data: null })
          })
        return () => {
          alive = false
        }
      }, [focused])

      const visible = []
      for (const id of ids) {
        const meta = byId[id]
        if (!meta) continue
        if (archived.has(id)) continue
        if (meta.parentSessionId || meta.origin === 'subagent') continue
        visible.push(id)
      }
      const visibleSet = new Set(visible)

      function titleOf(id) {
        const meta = byId[id] || {}
        const title = typeof meta.title === 'string' ? meta.title.trim() : ''
        return title || `未命名对话 ${String(id).slice(0, 6)}`
      }

      function updatedAtOf(id) {
        const meta = byId[id] || {}
        return Number(meta.updatedAt) || 0
      }

      function idsInFolder(folderId) {
        const folder = folderById[folderId]
        const mine = dossier.entries.filter((entry) => entry.folderId === folderId)
        const byOrder = (a, b) => a.order - b.order
        const pinned = mine.filter((entry) => entry.pinned).sort(byOrder).map((entry) => entry.sessionId)
        const plain = mine.filter((entry) => !entry.pinned).sort(byOrder).map((entry) => entry.sessionId)
        const list = [...pinned, ...plain].filter((id) => visibleSet.has(id))
        if (folder && folder.sort === 'time') list.sort((a, b) => updatedAtOf(b) - updatedAtOf(a))
        if (folder && folder.sort === 'name') list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'zh-Hans-CN', { numeric: true }))
        return list
      }

      function looseIds() {
        const list = visible.filter((id) => !entryOf[id])
        if (looseSort === 'name') return list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'zh-Hans-CN', { numeric: true }))
        return list.sort((a, b) => updatedAtOf(b) - updatedAtOf(a))
      }

      function activeIds() {
        if (sel.kind === 'folders') return []
        if (sel.kind === 'folder') return idsInFolder(sel.id)
        if (sel.kind === 'all') {
          const list = visible.slice()
          if (looseSort === 'name') return list.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'zh-Hans-CN', { numeric: true }))
          return list.sort((a, b) => updatedAtOf(b) - updatedAtOf(a))
        }
        return looseIds()
      }

      async function act(label, fn) {
        setBusy(label)
        setError('')
        try {
          await fn()
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy('')
        }
      }

      function openSession(id) {
        try {
          if (ctxRef && ctxRef.uiWorkspace && typeof ctxRef.uiWorkspace.openSession === 'function') {
            ctxRef.uiWorkspace.openSession(id)
          }
        } catch (err) {
          setError(messageOf(err))
        }
      }

      // 多选归入：逐个提交，最后一个响应带回完整状态
      function assignMany(folderId) {
        const targets = picked.slice()
        if (!targets.length) return
        act('assign', async () => {
          for (const sessionId of targets) {
            await runOp({ op: 'entry.assign', sessionId, folderId })
          }
          setPicked([])
          setPicking(false)
          setAssignOpen(false)
        })
      }

      function togglePick(id) {
        setPicked((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
      }

      function moveEntry(sessionId, delta) {
        act('move', () => runOp({ op: 'entry.move', sessionId, delta }))
      }

      /* 改对话名：走客户端的会话服务（和侧边栏里改名同一个入口），
         改的是宿主自己的会话标题，所以工作区里的对话也跟着改名。 */
      function renameSessionTo(id, title) {
        const next = String(title || '').trim()
        const before = titleOf(id)
        setRenamingSession(null)
        if (!next || next === before) return
        act('rename-session', async () => {
          const sessions = ctxRef && ctxRef.sessions
          if (!sessions || typeof sessions.using !== 'function') throw new Error('会话服务不可用，改不了名')
          const result = await sessions.using(id, { source: 'workspaceOperation' }, (reference) => {
            const session = reference && reference.binding && reference.binding.session
            if (!session || typeof session.rename !== 'function') throw new Error('这个版本的会话不支持改名')
            return session.rename(next)
          })
          if (result && result.ok === false) throw new Error((result.error && result.error.message) || '改名失败')
        })
      }

      /* 从卷宗里移出：对话本身不删，交接文档也不动 */
      function removeEntry(id) {
        const name = titleOf(id)
        askConfirm(
          `把「${name}」移出卷宗？`,
          ['只从卷宗里移出，这条对话本身不会被删除。', '它的交接文档留在原地，仍然能从「交接文档」里找到。'],
          '移出',
          false,
          () => act('remove-entry', () => runOp({ op: 'entry.assign', sessionId: id, folderId: null })),
        )
      }

      /* 从一条对话跳到它的交接文档：展开那一组并把那一行滚到眼前，不打开文件 */
      function locateHandoff(id) {
        const handoff = dossier.handoffs[id]
        const path = handoff && handoff.path
        setDocNote('')
        if (!path) {
          setDocFocus('')
          setDocNote('这条对话还没有交接文档')
          setSelection({ kind: 'docs', id: '' })
          return
        }
        jumpToDoc(path)
      }

      /* 这条对话一共有几份交接文档：从已读到的文档列表里挑，按阶段号（文件名）排 */
      function handoffDocsOf(id) {
        if (!id || !docs) return []
        const all = []
        for (const folder of docs.folders || []) for (const file of folder.files || []) all.push(file)
        for (const file of docs.loose || []) all.push(file)
        return all
          .filter((file) => file.sessionId === id)
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true }))
      }

      /* 跳到某一份文档：不管它现在归在卷宗里还是未归档，都由 docJump 那条 effect 决定切到哪一页 */
      function jumpToDoc(path) {
        setDocFocus('')
        setDocNote('')
        setDocOpen('')
        setDocJump(path)
      }

      /* 「已交接 N 次」点一下：只有一份就直接跳，多了就先列出来让用户挑 */
      function openHandoffs(id) {
        const list = handoffDocsOf(id)
        if (list.length === 1) {
          jumpToDoc(list[0].path)
          return
        }
        setHoMenu(id)
      }

      /* 卷宗标记点一下：切到那个卷宗页 */
      function openFolderPage(folderId) {
        if (!folderId || !folderById[folderId]) return
        setSelection({ kind: 'folder', id: folderId })
      }

      function createFolder() {
        const name = draftName.trim()
        if (!name) {
          setCreating(false)
          setDraftName('')
          return
        }
        act('create', () =>
          runOp({ op: 'folder.create', name }).then((body) => {
            const created = (body.folders || []).find((item) => item.name === name)
            if (created) setSelection({ kind: 'folder', id: created.id })
            setCreating(false)
            setDraftName('')
          }),
        )
      }

      /* 归入浮层里的「＋ 新建卷宗」：建完卷宗留在浮层里，可以直接选中归入 */
      function createFolderInMenu() {
        const name = assignNew.trim()
        if (!name) {
          setCreatingInMenu(false)
          setAssignNew('')
          return
        }
        act('create', () => runOp({ op: 'folder.create', name }))
        setCreatingInMenu(false)
        setAssignNew('')
      }

      function renameFolder(id, name) {
        const next = String(name || '').trim()
        if (!next) {
          setRenaming(null)
          return
        }
        act('rename', () => runOp({ op: 'folder.rename', id, name: next })).then(() => setRenaming(null))
      }

      /* 插件自己的确认框：不用 window.confirm（它跟面板风格完全不搭） */
      function askConfirm(title, lines, okLabel, danger, onOk) {
        setDialogShake(0)
        setConfirmAsk({ title, lines: lines || [], okLabel: okLabel || '确定', danger: Boolean(danger), onOk })
      }

      /* 模态框：Esc 等于取消；点空白不关（只抖一下），必须按一个按钮才继续 —— 跟系统对话框一个脾气 */
      React.useEffect(() => {
        if (!confirmAsk) {
          setDialogShake(0)
          return undefined
        }
        const onKey = (event) => {
          if (event.key === 'Escape' || event.key === 'Esc') setConfirmAsk(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [confirmAsk])

      /* 两个浮层（归入…／挑一份交接文档）也用同一个「点外面就抖」的规矩，重开时把抖动次数清零 */
      React.useEffect(() => {
        if (!assignOpen && !hoMenu) setMenuShake(0)
      }, [assignOpen, hoMenu])

      function removeFolder(id, name) {
        askConfirm(
          `删除卷宗「${name}」？`,
          ['里面的对话不会被删除，只会回到「未归档」。', '它的交接文档不会丢，会并入「未归档」继续列出来。'],
          '删除',
          true,
          () => {
            act('remove', () => runOp({ op: 'folder.remove', id })).then(() => {
              if (selection.kind === 'folder' && selection.id === id) setSelection({ kind: 'folders', id: '' })
            })
          },
        )
      }

      function setFolderSort(folder, mode) {
        act('sort', () => runOp({ op: 'folder.sort', id: folder.id, sort: mode }))
      }

      function pinEntry(sessionId, pinned) {
        act('pin', () => runOp({ op: 'entry.pin', sessionId, pinned }))
      }

      function moveFolder(id, delta) {
        act('fmove', () => runOp({ op: 'folder.move', id, delta }))
      }

      function pinFolder(id, pinned) {
        act('fpin', () => runOp({ op: 'folder.pin', id, pinned }))
      }

      /* 卷宗不能被移进卷宗，多选在这里只有一个出口：批量删除 */
      function deletePickedFolders() {
        const targets = picked.slice()
        if (!targets.length) return
        const names = targets.map((id) => (folderById[id] ? folderById[id].name : id))
        askConfirm(
          `删除 ${targets.length} 个卷宗？`,
          [`要删的是：${names.join('、')}`, '里面的对话不会被删除，只会回到「未归档」。', '交接文档并入「未归档」，不会丢。'],
          '删除',
          true,
          () => {
            act('remove', async () => {
              for (const id of targets) await runOp({ op: 'folder.remove', id })
              setPicked([])
              setPicking(false)
            })
          },
        )
      }

      /* ---------------------------------- 交接文档：导出 / 删除 / 定位 */

      // 导出目录由用户现选：优先用宿主的目录选择器，拿不到就提示。
      async function pickExportDir() {
        const service = ctxRef
        const picker = service && service.uiWorkspace
        if (!picker || typeof picker.pickDirectory !== 'function') return ''
        try {
          const value = await picker.pickDirectory()
          if (!value) return ''
          if (typeof value === 'string') return value
          return String(value.path || value.directory || value.dir || '')
        } catch {
          return ''
        }
      }

      function docAction(op, files, targetDir) {
        return postJson(`${BASE}/docop`, { op, files, targetDir: targetDir || '', viewSessionId }).then((body) => {
          loadDocs()
          return body
        })
      }

      async function exportDocs(files) {
        const list = (files || []).slice()
        if (!list.length) return
        const dir = await pickExportDir()
        if (!dir) {
          setDocNote('没有选到导出目录')
          return
        }
        await act('export', async () => {
          const body = await docAction('export', list, dir)
          const okCount = body && body.done ? body.done.length : 0
          const badCount = body && body.failed ? body.failed.length : 0
          setDocNote(`已导出 ${okCount} 份到 ${dir}${badCount ? `，${badCount} 份失败` : ''}`)
          setDocPicked([])
          setDocPicking(false)
        })
      }

      /* 整包导出：把交接目录里所有文档打成一个 json 带走（换机器用） */
      async function exportBundle() {
        const dir = await pickExportDir()
        if (!dir) {
          setDocNote('没有选到导出目录')
          return
        }
        await act('export-bundle', async () => {
          const body = await postJson(`${BASE}/docop`, { op: 'exportBundle', targetDir: dir, viewSessionId })
          setDocNote(`已打包 ${body.count || 0} 份文档：${body.file || dir}`)
        })
      }

      /* 整包导入：选本地 json → 宿主写回 goals/（同名同内容跳过，内容不同加后缀） */
      function pickBundle() {
        if (bundleInput.current) bundleInput.current.click()
      }

      function onBundlePicked(event) {
        const input = event.target
        const file = input.files && input.files[0]
        input.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          let bundle = null
          try {
            bundle = JSON.parse(String(reader.result))
          } catch {
            bundle = null
          }
          if (!bundle || !Array.isArray(bundle.files)) {
            setDocNote('这个文件不是卷宗导出的交接包')
            return
          }
          askConfirm(
            `导入 ${bundle.files.length} 份交接文档？`,
            [
              '包里每份文档都记着它属于哪条对话、哪个卷宗。',
              '那条对话还在本机：导入后「定位」照样能用；对话已不在：按导出时的卷宗归位。',
              '同名且内容一致会跳过。同名但内容不同会另存为 -2、-3，不会覆盖现有文档。',
            ],
            '导入',
            false,
            () => {
              act('import-bundle', async () => {
                const body = await postJson(`${BASE}/docop`, { op: 'importBundle', bundle, viewSessionId })
                const list = (body && body.done) || []
                const skipped = list.filter((item) => item.skipped).length
                const failed = (body && body.failed) || []
                const bits = [`导入完成：${list.length} 份`]
                if (skipped) bits.push(`${skipped} 份内容一致已跳过`)
                if (body && body.restored) bits.push(`${body.restored} 条对话的「定位」接回来了`)
                if (failed.length) bits.push(`${failed.length} 份失败`)
                setDocNote(bits.join('，'))
                loadDocs()
              })
            },
          )
        }
        reader.readAsText(file)
      }

      function deleteDocs(files) {
        const list = (files || []).slice()
        if (!list.length) return
        askConfirm(
          `删除 ${list.length} 份交接文档？`,
          ['文件会从 goals/ 里真的删掉，删了不能恢复。', '备份目录 ~/.dsh/dossier/handoffs 里那一份还在。'],
          '删除',
          true,
          () => {
            act('deldoc', async () => {
              const body = await docAction('delete', list)
              const okCount = body && body.done ? body.done.length : 0
              setDocNote(`已删除 ${okCount} 份`)
              setDocPicked([])
              setDocPicking(false)
            })
          },
        )
      }

      /* 定位：跳到生成这份文档的会话；文档没记录会话、或会话已经不在列表里，就只提示不跳 */
      function locateDoc(file) {
        const sid = file && file.sessionId
        setDocNote('')
        if (!sid) {
          setDocNote('这份文档没有记录来源会话（早期生成或手工放进来的），无法定位')
          return
        }
        if (!visibleSet.has(sid)) {
          setDocNote('生成它的对话已经不在了（被删除或归档），无法定位')
          return
        }
        openSession(sid)
      }

      function toggleDocPick(path) {
        setDocPicked((current) => (current.includes(path) ? current.filter((item) => item !== path) : current.concat(path)))
      }

      function groupFiles(group) {
        return group && group.files ? group.files.map((file) => file.path) : []
      }

      /* 文档路径 → 文件名，用于清单和消息里附注 */
      function docNameOf(path) {
        for (const group of (docs && docs.folders) || []) {
          for (const file of group.files || []) if (file.path === path) return file.name
        }
        for (const file of (docs && docs.loose) || []) if (file.path === path) return file.name
        return ''
      }

      /* 拿选中的交接文档开一个新对话：新对话的第一条消息就是「先读这几份，再接着做」。
         交接文档里写的是状态和下一步，所以新对话读它比读旧对话便宜得多。 */
      async function newChatWithDocs(paths) {
        const list = (paths || []).filter(Boolean)
        if (!list.length) return
        const sessions = ctxRef && ctxRef.sessions
        if (!sessions || typeof sessions.create !== 'function') throw new Error('会话服务不可用，建不了新对话')
        const text = [
          '【卷宗·接力】这是一个新对话。先读下面这些交接文档，再按里面的「当前状态」和「下一步」接着做：',
          '',
          ...list.map((path, index) => {
            const name = docNameOf(path)
            return `${index + 1}. ${path}${name ? `　（${name}）` : ''}`
          }),
          '',
          '读完先回一句：你打算从这个状态往下做的第一步是什么。',
        ].join('\n')
        const cwd = (dossier && dossier.paths && dossier.paths.cwd) || ''
        const sessionId = await sessions.create(cwd ? { cwd } : {})
        if (!sessionId) throw new Error('新对话没建起来')
        await sessions.using(sessionId, { source: 'workspaceOperation' }, async (reference) => {
          const session = reference && reference.binding && reference.binding.session
          if (!session || typeof session.prompt !== 'function') throw new Error('新对话还不能收消息')
          const result = await session.prompt([{ type: 'text', text }], 'queue')
          if (result && result.ok === false) {
            const reason = (result.error && (result.error.message || result.error.code)) || '未知原因'
            throw new Error(`交接文档没发进新对话：${reason}`)
          }
        })
        setDocPicking(false)
        setDocPicked([])
        setDocNote('')
        openSession(sessionId)
      }

      /* 开新对话之前先问一句：列清楚要带哪几份、会发生在哪，别一点就凭空多出一个对话 */
      function startChatWithDocs(paths) {
        const list = (paths || []).filter(Boolean)
        if (!list.length) return
        const shown = list.slice(0, 4).map((path) => {
          const name = docNameOf(path)
          return `· ${name || path}`
        })
        if (list.length > shown.length) shown.push(`· …还有 ${list.length - shown.length} 份`)
        askConfirm(
          `用 ${list.length} 份交接文档开一个新对话？`,
          [
            ...shown,
            '新对话建在同一个工作目录里；第一条消息就是要它读这几份文档、按「下一步」接着做。',
            '原来这条对话不动，也不会被改动。',
          ],
          '开新对话',
          false,
          () => act('new-chat', () => newChatWithDocs(list)),
        )
      }

      /* 卷宗最近活跃时间：卷宗里最新的对话更新时间，空卷宗回落创建时间 */
      function folderLastAt(folder) {
        let at = Number(folder.createdAt) || 0
        for (const entry of dossier.entries) {
          if (entry.folderId !== folder.id) continue
          const when = updatedAtOf(entry.sessionId)
          if (when > at) at = when
        }
        return at
      }

      /* 左栏永远按「默认顺序」排，跟着 order 字段走；置顶的排在最前面 */
      function folderOrdered() {
        return folders.slice().sort((a, b) => {
          const pinA = a.pinned ? 1 : 0
          const pinB = b.pinned ? 1 : 0
          if (pinA !== pinB) return pinB - pinA
          return (Number(a.order) || 0) - (Number(b.order) || 0)
        })
      }

      /* 卷宗列表视图里的排序：默认 / 时间 / 名称，只影响显示；置顶的始终在最前 */
      function displayFolders() {
        const list = folderOrdered()
        if (folderViewSort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
        else if (folderViewSort === 'time') list.sort((a, b) => folderLastAt(b) - folderLastAt(a))
        return list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
      }

      /* 文档跟着对话走：生成它的对话已经不在了的，从卷宗组里摘出来放进未归档 */
      function docsViewOf(source) {
        if (!source) return { folders: [], loose: [], filed: 0, total: 0 }
        const dead = []
        const folders = (source.folders || []).map((group) => {
          const keep = []
          for (const file of group.files || []) {
            if (file.sessionId && !byId[file.sessionId]) dead.push(file)
            else keep.push(file)
          }
          return { ...group, files: keep, latestAt: keep.length ? keep[0].mtime : 0 }
        })
        const loose = [...(source.loose || []), ...dead].sort((a, b) => b.mtime - a.mtime)
        const filed = folders.reduce((sum, group) => sum + group.files.length, 0)
        return { folders, loose, filed, total: filed + loose.length }
      }

      /* --------------------------------------------------------- 渲染片段 */

      function sideRow(key, label, active, onClick, trailing, extraClass, leading) {
        return h(
          'div',
          {
            key,
            className: `dz-side-row${active ? ' is-active' : ''}${extraClass ? ` ${extraClass}` : ''}`,
            onClick,
            role: 'button',
            tabIndex: 0,
          },
          [
            leading || null,
            h('span', { className: 'dz-side-label', key: 'l' }, label),
            trailing
              ? h(
                  'span',
                  {
                    key: 't',
                    onClick: (event) => {
                      event.stopPropagation()
                    },
                  },
                  trailing,
                )
              : null,
          ],
        )
      }

      /* 行内动作统一走图标按钮：对话和卷宗都用同一套，省格子、也不抢标题的宽度 */
      function icoBtn(key, name, title, onClick, opts) {
        const options = opts || {}
        return h(
          'button',
          {
            key,
            className: `dz-icon-btn${options.on ? ' is-on' : ''}${options.danger ? ' is-danger' : ''}`,
            title,
            'aria-label': title,
            disabled: Boolean(busy) || Boolean(options.disabled),
            onClick: (event) => {
              event.stopPropagation()
              onClick()
            },
          },
          glyph(name),
        )
      }

      function sessionRow(id) {
        const meta = byId[id] || {}
        const entry = entryOf[id] || null
        const folderId = entry ? entry.folderId : ''
        const folder = folderId ? folderById[folderId] : null
        const handoff = dossier.handoffs[id]
        const inFolderView = sel.kind === 'folder'
        const sortMode = folder ? folder.sort || 'manual' : 'manual'
        const canReorder = inFolderView && folder && sortMode === 'manual'
        const isFocused = focused === id
        const isPicked = picked.includes(id)
        const editing = renamingSession && renamingSession.id === id

        /* 标题与标记分开：卡片里标题独占第一行，标记统一在第二行 */
        const isGrid = view === 'grid'
        /* 每次交接都记在自己身上：这条对话交接了几次，跟它在哪个卷宗无关 */
        const handoffCount = handoff ? Math.max(1, Number(handoff.count) || 1) : 0
        const titleBits = editing
          ? [
              h('input', {
                key: 'edit',
                className: 'dz-input dz-row-edit',
                autoFocus: true,
                value: renamingSession.draft,
                onClick: (event) => event.stopPropagation(),
                onChange: (event) => setRenamingSession({ id, draft: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') renameSessionTo(id, event.target.value)
                  if (event.key === 'Escape') setRenamingSession(null)
                },
                onBlur: (event) => renameSessionTo(id, event.target.value),
              }),
            ]
          : [
              h('span', { key: 'ico', className: 'dz-row-ico', 'aria-hidden': true }, glyph('chat')),
              h('span', { key: 't', className: 'dz-row-title' }, titleOf(id)),
            ]
        const tagBits = []
        if (handoff) {
          /* 交接次数是链接：点它就跳到那份交接文档；有多份时先弹一份清单让用户挑 */
          const many = handoffDocsOf(id).length > 1
          tagBits.push(
            h(
              'button',
              {
                key: 'h',
                className: 'dz-tag is-brand dz-tag-tight dz-tag-link',
                title: many
                  ? `这条对话交接了 ${handoffCount} 次，点一下挑一份打开`
                  : `这条对话交接了 ${handoffCount} 次，点一下跳到那份交接文档`,
                onClick: (event) => {
                  event.stopPropagation()
                  openHandoffs(id)
                },
              },
              [
                h('span', { key: 't', className: 'dz-tag-name' }, `已交接 ${handoffCount} 次`),
                /* 只有多份交接文档时才给一个「▾」提示可以挑；单份不再挂「→」，
                   标记本身就够短了，箭头只会多占一截宽度、还像是没点中。 */
                many
                  ? h('span', { key: 'caret', className: 'dz-tag-caret', 'aria-hidden': true }, '▾')
                  : null,
              ],
            ),
          )
        }
        if (!inFolderView && folder) {
          tagBits.push(
            h(
              'button',
              {
                key: 'f',
                className: 'dz-tag is-folder dz-tag-tight dz-tag-link',
                title: `已在卷宗「${folder.name}」里，点一下打开这个卷宗`,
                onClick: (event) => {
                  event.stopPropagation()
                  openFolderPage(folder.id)
                },
              },
              [
                h('span', { key: 'i', className: 'dz-tag-ico' }, glyph('folder')),
                h('span', { key: 'n', className: 'dz-tag-name' }, folder.name),
              ],
            ),
          )
        }
        /* 勾选中的对话如果已经在某个卷宗里，右侧给一句显眼提醒，避免被误归到别处 */
        const folderHint =
          isPicked && folder
            ? h('span', { key: 'hint', className: 'dz-row-hint', title: `再归入别的卷宗会把它从「${folder.name}」里移走` }, `已在「${folder.name}」`)
            : null

        const metaBits = []
        const when = relTime(updatedAtOf(id))
        if (when) metaBits.push(h('span', { key: 'w' }, when))
        /* 对话中 = 正在跑，或 30 分钟内说过话（前缀缓存大概率还热，这时候接着聊不花钱） */
        const lastAt = updatedAtOf(id)
        const age = lastAt ? Date.now() - lastAt : Infinity
        const live = Boolean(meta.running) || age < 30 * 60 * 1000
        if (live) {
          metaBits.push(
            h(
              'span',
              {
                key: 'r',
                className: 'dz-live',
                title: meta.running ? '正在生成回复' : '最近 30 分钟内说过话，缓存大概率还在',
              },
              [h('span', { key: 'd', className: `dz-dot${meta.running ? '' : ' is-soft'}` }), '对话中'],
            ),
          )
        }
        if (meta.blank) metaBits.push(h('span', { key: 'b' }, '空对话'))

        const actions = []
        if (picking || editing) {
          /* 多选和改名时不放动作按钮，避免误触 */
        } else {
          if (isFocused) {
            actions.push(
              h(
                'button',
                {
                  key: 'enter',
                  className: 'dz-btn is-primary',
                  title: '进入这个对话',
                  onClick: (event) => {
                    event.stopPropagation()
                    openSession(id)
                  },
                },
                '进入对话',
              ),
            )
          }
          if (canReorder) {
            actions.push(icoBtn('pin', 'pin', entry && entry.pinned ? '取消置顶' : '置顶到最前', () => pinEntry(id, !(entry && entry.pinned)), { on: Boolean(entry && entry.pinned) }))
            if (!isGrid) {
              actions.push(icoBtn('up', 'up', '上移一位', () => moveEntry(id, -1)))
              actions.push(icoBtn('down', 'down', '下移一位', () => moveEntry(id, 1)))
            }
          }
          actions.push(icoBtn('ren', 'edit', '重命名这条对话（工作区里的标题一起改）', () => setRenamingSession({ id, draft: titleOf(id) })))
          if (folder) {
            actions.push(icoBtn('out', 'out', `移出卷宗「${folder.name}」`, () => removeEntry(id), { danger: true }))
          }
          if (handoff) {
            actions.push(icoBtn('loc', 'locate', '定位到它的交接文档', () => locateHandoff(id)))
          }
        }
        const row = h(
          'div',
          {
            key: `row-${id}`,
            className: [
              'dz-row',
              isFocused ? 'is-focus' : '',
              isPicked ? 'is-picked' : '',
              entry && entry.pinned && canReorder ? 'is-pinned' : '',
            ]
              .filter(Boolean)
              .join(' '),
            onClick: () => {
              if (picking) togglePick(id)
              else if (!editing) setFocused(isFocused ? '' : id)
            },
            onDoubleClick: () => {
              if (!picking && !editing) openSession(id)
            },
            role: 'button',
            tabIndex: 0,
            title: editing
              ? '回车保存，Esc 放弃'
              : picking
                ? isPicked
                  ? '再点一下取消勾选'
                  : '勾选这个对话'
                : '点一下选中，再点「进入对话」打开；双击直接进入',
          },
          [
            picking
              ? h('span', { key: 'ck', className: `dz-check${isPicked ? ' is-on' : ''}` })
              : null,
            h('div', { key: 'main', className: 'dz-row-main' }, [
              isGrid
                ? h('div', { key: 'l1', className: 'dz-row-line' }, titleBits)
                : h('div', { key: 'l1', className: 'dz-row-line' }, [...titleBits, ...tagBits, folderHint]),
              isGrid
                ? h('div', { key: 'l2', className: 'dz-row-line dz-row-tags' }, tagBits.length ? tagBits : h('span', { key: 'e', className: 'dz-row-blank' }, ''))
                : null,
              isGrid
                ? h('div', { key: 'l3', className: 'dz-row-line dz-row-hintline' }, folderHint)
                : null,
              isGrid
                ? h('div', { key: 'm', className: 'dz-row-meta dz-row-when' }, metaBits.length ? metaBits : h('span', { key: 'e', className: 'dz-row-blank' }, ''))
                : metaBits.length
                  ? h('div', { key: 'm', className: 'dz-row-meta' }, metaBits)
                  : null,
            ]),
            actions.length
              ? h('div', { key: 'acts', className: `dz-row-actions${isFocused || editing ? ' is-visible' : ''}` }, actions)
              : null,
          ],
        )

        return h('div', { key: `cell-${id}`, className: 'dz-cell' }, [row])
      }

      function folderRow(folder) {
        if (renaming && renaming.id === folder.id) {
          return h('div', { key: `cell-${folder.id}`, className: 'dz-cell' }, [
            h('div', { key: 'edit', className: 'dz-row' }, [
              h('span', { key: 'ico', className: 'dz-fico' }, glyph('folder')),
              h('input', {
                key: 'i',
                className: 'dz-input',
                autoFocus: true,
                value: renaming.draft,
                onChange: (event) => setRenaming({ id: folder.id, draft: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') renameFolder(folder.id, renaming.draft)
                  if (event.key === 'Escape') setRenaming(null)
                },
                onBlur: () => renameFolder(folder.id, renaming.draft),
              }),
            ]),
          ])
        }
        const count = dossier.entries.filter((entry) => entry.folderId === folder.id).length
        const isPicked = picked.includes(folder.id)
        const manual = folderViewSort === 'manual'
        const last = folderLastAt(folder)
        const actions = []
        if (!picking) {
          if (manual) {
            actions.push(icoBtn('up', 'up', '上移一位', () => moveFolder(folder.id, -1)))
            actions.push(icoBtn('down', 'down', '下移一位', () => moveFolder(folder.id, 1)))
          }
          actions.push(icoBtn('pin', 'pin', folder.pinned ? '取消置顶' : '置顶到最前', () => pinFolder(folder.id, !folder.pinned), { on: Boolean(folder.pinned) }))
          actions.push(icoBtn('ren', 'edit', '重命名这个卷宗', () => setRenaming({ id: folder.id, draft: folder.name })))
          actions.push(icoBtn('del', 'del', `删除卷宗「${folder.name}」`, () => removeFolder(folder.id, folder.name), { danger: true }))
        }

        const row = h(
          'div',
          {
            key: `row-${folder.id}`,
            className: `dz-row${isPicked ? ' is-picked' : ''}${folder.pinned ? ' is-pinned' : ''}`,
            onClick: () => {
              if (picking) togglePick(folder.id)
              else setSelection({ kind: 'folder', id: folder.id })
            },
            role: 'button',
            tabIndex: 0,
            title: picking ? (isPicked ? '再点一下取消勾选' : '勾选这个卷宗') : `打开卷宗「${folder.name}」`,
          },
          [
            picking ? h('span', { key: 'ck', className: `dz-check${isPicked ? ' is-on' : ''}` }) : null,
            h('div', { key: 'main', className: 'dz-row-main' }, [
              h('div', { key: 'l1', className: 'dz-row-line' }, [
                h('span', { key: 'ico', className: 'dz-fico' }, glyph('folder')),
                h('span', { key: 't', className: 'dz-row-title' }, folder.name),
              ]),
              view === 'grid' ? h('div', { key: 'l2', className: 'dz-row-line dz-row-tags' }, h('span', { key: 'c', className: 'dz-tag dz-tag-tight' }, `${count} 个对话`)) : null,
              view === 'grid' ? h('div', { key: 'l3', className: 'dz-row-line dz-row-hintline' }, h('span', { key: 'e', className: 'dz-row-blank' }, '')) : null,
              h('div', { key: 'm', className: `dz-row-meta${view === 'grid' ? ' dz-row-when' : ''}` }, [
                view === 'grid' ? null : h('span', { key: 'c' }, `${count} 个对话`),
                last ? h('span', { key: 'w' }, relTime(last)) : null,
              ]),
            ]),
            actions.length ? h('div', { key: 'acts', className: 'dz-row-actions' }, actions) : null,
          ],
        )

        return h('div', { key: `cell-${folder.id}`, className: 'dz-cell' }, [row])
      }

      /* -------------------------------------------------------- 左侧栏 */

      const sideChildren = []
      const docView = docsViewOf(docs)
      const docLooseCount = docView.loose.length
      const docFiledCount = docView.filed
      sideChildren.push(
        sideRow(
          'docs',
          '交接文档',
          sel.kind === 'docs',
          () => setSelection({ kind: 'docs', id: '' }),
          h('span', { className: 'dz-side-meta' }, docs ? String(docFiledCount) : ''),
          '',
          h('span', { key: 'star', className: 'dz-side-ico dz-star', 'aria-hidden': true }, '★'),
        ),
      )
      /* 另起一行、缩进两格：没归入卷宗的交接文档单独一个入口，
         它们不再混在「交接文档」页里当一组 —— 那一页只列卷宗。 */
      sideChildren.push(
        sideRow(
          'docLoose',
          '未归档',
          sel.kind === 'docLoose',
          () => setSelection({ kind: 'docLoose', id: '' }),
          h('span', { className: 'dz-side-meta' }, docs ? String(docLooseCount) : ''),
          'is-sub',
        ),
      )
      sideChildren.push(h('div', { key: 'sep0', className: 'dz-sep' }))
      sideChildren.push(
        sideRow(
          'all',
          '全部对话',
          sel.kind === 'all',
          () => setSelection({ kind: 'all', id: '' }),
          h('span', { className: 'dz-side-meta' }, String(visible.length)),
        ),
      )
      sideChildren.push(
        sideRow(
          'loose',
          '未归档',
          sel.kind === 'loose',
          () => setSelection({ kind: 'loose', id: '' }),
          h('span', { className: 'dz-side-meta' }, String(looseIds().length)),
          'is-sub',
        ),
      )
      sideChildren.push(h('div', { key: 'sep', className: 'dz-sep' }))

      /* 卷宗：一个分组标题 + 下面缩进两格的各个卷宗（顺序跟着「默认顺序」走）。
         这一整块单独限高自己滚 —— 卷宗只会越建越多，不能把左栏一直往下拉长。 */
      const folderRows = []
      folderRows.push(
        sideRow(
          'folders',
          '卷宗',
          sel.kind === 'folders',
          () => setSelection({ kind: 'folders', id: '' }),
          h('span', { className: 'dz-side-meta' }, String(folders.length)),
        ),
      )

      for (const folder of folderOrdered()) {
        const count = dossier.entries.filter((entry) => entry.folderId === folder.id).length
        const active = sel.kind === 'folder' && sel.id === folder.id
        if (renaming && renaming.id === folder.id && sel.kind !== 'folders') {
          folderRows.push(
            h('div', { key: `edit-${folder.id}`, className: 'dz-side-row is-sub' }, [
              h('input', {
                key: 'i',
                className: 'dz-input',
                autoFocus: true,
                value: renaming.draft,
                onChange: (event) => setRenaming({ id: folder.id, draft: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') renameFolder(folder.id, renaming.draft)
                  if (event.key === 'Escape') setRenaming(null)
                },
                onBlur: () => renameFolder(folder.id, renaming.draft),
              }),
            ]),
          )
          continue
        }
        folderRows.push(
          sideRow(
            folder.id,
            folder.name,
            active,
            () => setSelection({ kind: 'folder', id: folder.id }),
            h('span', { className: 'dz-side-meta' }, String(count)),
            'is-sub',
            h('span', { key: 'ico', className: 'dz-side-ico' }, folder.pinned ? glyph('pin') : glyph('folder')),
          ),
        )
      }
      sideChildren.push(h('div', { key: 'fscroll', className: 'dz-side-scroll' }, folderRows))

      sideChildren.push(h('div', { key: 'sep2', className: 'dz-sep' }))

      if (creating) {
        sideChildren.push(
          h('div', { key: 'new', className: 'dz-side-row' }, [
            h('input', {
              key: 'i',
              className: 'dz-input',
              autoFocus: true,
              placeholder: '卷宗名，回车创建',
              value: draftName,
              onChange: (event) => setDraftName(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') createFolder()
                if (event.key === 'Escape') {
                  setCreating(false)
                  setDraftName('')
                }
              },
            }),
          ]),
        )
      } else {
        sideChildren.push(
          h(
            'button',
            {
              key: 'newbtn',
              className: 'dz-btn dz-block',
              onClick: () => {
                setCreating(true)
                setDraftName('')
              },
            },
            '＋ 新建卷宗',
          ),
        )
      }

      sideChildren.push(
        h('div', { key: 'foot', className: 'dz-side-foot' }, [
          h('div', { key: 'a' }, '一个对话只属于一个卷宗。'),
          h('div', { key: 'c' }, '交接文档写到项目里，并自动备份。'),
        ]),
      )

      /* -------------------------------------------------------- 右侧主体 */

      const list = activeIds()
      const inFoldersView = sel.kind === 'folders'
      let mainTitle = '未归档'
      let mainSub = '还没有归入任何卷宗的对话。'
      const headActions = []

      const activeFolder = sel.kind === 'folder' ? folderById[sel.id] : null
      const sortNow = inFoldersView ? folderViewSort : activeFolder ? activeFolder.sort || 'manual' : looseSort
      const pickSort = (mode) => {
        if (inFoldersView) {
          setFolderViewSort(mode)
          saveFoldersSort(mode)
        } else if (activeFolder) setFolderSort(activeFolder, mode)
        else {
          setLooseSort(mode)
          saveSort(mode)
        }
      }

      /* 三个图标：默认（可排序/置顶）、按时间、按名称 */
      const ICONS = {
        manual: [
          h('path', { key: 'a', d: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11' }),
        ],
        time: [
          h('circle', { key: 'c', cx: 8, cy: 8, r: 5.6 }),
          h('path', { key: 'h', d: 'M8 4.6V8l2.4 1.5' }),
        ],
        name: [
          h('text', { key: 'a', x: 1.4, y: 11.6, fontSize: 8, fill: 'currentColor', stroke: 'none' }, 'A'),
          h('text', { key: 'b', x: 7.6, y: 11.6, fontSize: 8, fill: 'currentColor', stroke: 'none' }, 'Z'),
        ],
      }
      const sortButton = (mode, label) =>
        h(
          'button',
          {
            key: `sort-${mode}`,
            className: `dz-icon-btn${sortNow === mode ? ' is-on' : ''}`,
            title: label,
            'aria-label': label,
            onClick: () => pickSort(mode),
          },
          h(
            'svg',
            {
              viewBox: '0 0 16 16',
              width: 15,
              height: 15,
              fill: 'none',
              stroke: 'currentColor',
              'stroke-width': 1.4,
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
              'aria-hidden': true,
            },
            ICONS[mode],
          ),
        )

      if (sel.kind !== 'docs' && sel.kind !== 'docLoose' && !picking) {
        headActions.push(
          h('div', { key: 'sort', className: 'dz-icons' }, [
            inFoldersView || activeFolder ? sortButton('manual', inFoldersView ? '默认顺序：可 ↑↓ 调整' : '默认顺序：可 ↑↓ 调整、可置顶') : null,
            sortButton('time', '按最近更新排序（只影响显示）'),
            sortButton('name', '按名称排序（只影响显示）'),
          ]),
        )
        headActions.push(
          h(
            'button',
            {
              key: 'view',
              className: 'dz-btn',
              title: view === 'grid' ? '当前：卡片网格，点一下换成列表' : '当前：单列列表，点一下换成卡片',
              onClick: () => {
                const next = view === 'grid' ? 'list' : 'grid'
                setView(next)
                saveView(next)
              },
            },
            view === 'grid' ? '▦' : '▤',
          ),
        )
      }

      if (sel.kind === 'all') {
        mainTitle = '全部对话'
        mainSub = picking ? '勾选要归入的对话，再点右上「归入…」' : `共 ${visible.length} 个对话`
      } else if (sel.kind === 'folder') {
        const folder = folderById[sel.id]
        if (folder) {
          mainTitle = folder.name
          mainSub = picking
            ? '勾选要移出或移到别的卷宗的对话，再点右上「归入…」'
            : folder.sort === 'time'
              ? '按最近更新，只影响显示'
              : folder.sort === 'name'
                ? '按名称，只影响显示'
                : '默认顺序：每个对话右侧都能 ↑↓ 调位、置顶、改名、移出'
        }
      } else if (sel.kind === 'loose') {
        mainTitle = '未归档'
        mainSub = picking ? '勾选要归入的对话，再点右上「归入…」' : '还没有归入任何卷宗的对话。'
      } else if (inFoldersView) {
        mainTitle = '卷宗'
        mainSub = picking
          ? '勾选要删除的卷宗，再点右上「删除」'
          : folderViewSort === 'time'
            ? '按最近活跃排序，只影响显示'
            : folderViewSort === 'name'
              ? '按名称排序，只影响显示'
              : `共 ${folders.length} 个卷宗：默认顺序可切换，左栏跟着它走`
      }

      /* 多选：先「选择」，勾完再「归入…」——不再用行内的小按钮 */
      if (inFoldersView) {
        if (picking) {
          headActions.push(
            h('span', { key: 'count', className: 'dz-pick-count' }, picked.length ? `已选 ${picked.length}` : '还没勾选'),
          )
          headActions.push(
            h(
              'button',
              {
                key: 'delf',
                className: 'dz-btn is-danger',
                disabled: Boolean(busy) || !picked.length,
                title: '把勾选的卷宗删掉，里面的对话会回到「未归档」',
                onClick: deletePickedFolders,
              },
              '删除',
            ),
          )
          headActions.push(
            h(
              'button',
              {
                key: 'cancel',
                className: 'dz-btn',
                onClick: () => {
                  setPicking(false)
                  setPicked([])
                },
              },
              '取消',
            ),
          )
        } else {
          headActions.push(
            h(
              'button',
              {
                key: 'pick',
                className: 'dz-btn',
                disabled: Boolean(busy) || !folders.length,
                title: '进入多选，勾选后一起删除',
                onClick: () => {
                  setPicking(true)
                  setPicked([])
                  setFocused('')
                },
              },
              '选择',
            ),
          )
        }
      } else if (sel.kind !== 'docs' && sel.kind !== 'docLoose') {
        if (picking) {
          headActions.push(
            h('span', { key: 'count', className: 'dz-pick-count' }, picked.length ? `已选 ${picked.length}` : '还没勾选'),
          )
          headActions.push(
            h(
              'button',
              {
                key: 'assign',
                className: 'dz-btn is-primary',
                disabled: Boolean(busy) || !picked.length || !folders.length,
                title: folders.length ? '把这几个对话归入一个卷宗' : '还没有卷宗，先在左边新建一个',
                onClick: () => setAssignOpen(true),
              },
              '归入…',
            ),
          )
          if (sel.kind === 'folder') {
            headActions.push(
              h(
                'button',
                { key: 'out', className: 'dz-btn', disabled: Boolean(busy) || !picked.length, onClick: () => assignMany(null) },
                '移到未归档',
              ),
            )
          }
          headActions.push(
            h(
              'button',
              {
                key: 'cancel',
                className: 'dz-btn',
                onClick: () => {
                  setPicking(false)
                  setPicked([])
                },
              },
              '取消',
            ),
          )
        } else {
          headActions.push(
            h(
              'button',
              {
                key: 'pick',
                className: 'dz-btn',
                disabled: Boolean(busy) || !list.length,
                title: '进入多选，勾选后一起归入卷宗',
                onClick: () => {
                  setPicking(true)
                  setPicked([])
                  setFocused('')
                },
              },
              '选择',
            ),
          )
        }
      }

      const rows = inFoldersView ? displayFolders().map((folder) => folderRow(folder)) : list.map((id) => sessionRow(id))
      let empty = null
      let docsList = null
      if (sel.kind === 'docs' || sel.kind === 'docLoose') {
        const looseMode = sel.kind === 'docLoose'
        if (looseMode) {
          mainTitle = '未归档的交接文档'
          mainSub = docs
            ? `${docView.loose.length} 份 · 没有归入卷宗的，或卷宗被删掉后留下的`
            : '读取中…'
        } else {
          mainTitle = '交接文档'
          mainSub = docs
            ? `共 ${docView.filed} 份 · 点一行展开，展开后可以批量导出或删除`
            : '读取中…'
        }
        headActions.push(
          h(
            'button',
            {
              key: 'pick-docs',
              className: `dz-btn is-icon${docPicking ? ' is-on' : ''}`,
              disabled: Boolean(busy) || !(docs && docView.total),
              title: docPicking ? '退出逐份勾选' : '逐份勾选：勾好几份后一起导出、删除，或开一个新对话',
              onClick: () => {
                setDocPicking(!docPicking)
                setDocPicked([])
              },
            },
            glyph('check'),
          ),
        )
        headActions.push(
          h(
            'button',
            {
              key: 'bundle-out',
              className: 'dz-btn',
              disabled: Boolean(busy) || !(docs && docView.total),
              title: '把全部交接文档打成一个文件，换机器时带走',
              onClick: exportBundle,
            },
            [glyph('export'), h('span', { key: 't' }, '导出')],
          ),
        )
        headActions.push(
          h(
            'button',
            {
              key: 'bundle-in',
              className: 'dz-btn',
              disabled: Boolean(busy),
              title: '从别的机器导出的文件里恢复全部交接文档',
              onClick: pickBundle,
            },
            [glyph('import'), h('span', { key: 't' }, '导入')],
          ),
        )

        const kbOf = (file) => `${Math.max(1, Math.round(file.size / 1024))} KB`
        const docRow = (file, key) => {
          const on = docPicked.includes(file.path)
          const focusedDoc = docFocus === file.path
          /* 文档跟着对话走：名字显示对话现在的名字；对话没了就标一句 */
          const owner = file.sessionId ? byId[file.sessionId] : null
          const dead = Boolean(file.sessionId) && !owner
          return h('div', {
            key,
            className: `dz-doc-file${on ? ' is-picked' : ''}${focusedDoc ? ' is-focus' : ''}`,
            title: file.path,
            'data-doc-path': file.path,
          }, [
            docPicking
              ? h('span', {
                  key: 'ck',
                  className: `dz-check${on ? ' is-on' : ''}`,
                  onClick: (event) => {
                    event.stopPropagation()
                    toggleDocPick(file.path)
                  },
                })
              : null,
            h('span', { key: 'i', className: 'dz-doc-ico' }, glyph('doc')),
            h('span', { key: 'n', className: 'dz-doc-name' }, file.name),
            file.sessionId && owner
              ? h('span', { key: 'own', className: 'dz-doc-owner', title: `这条交接来自对话：${titleOf(file.sessionId)}` }, titleOf(file.sessionId))
              : null,
            dead
              ? h('span', { key: 'dead', className: 'dz-doc-dead', title: '生成这份文档的对话已经不在了，文档被收进未归档' }, '关联对话已删除')
              : null,
            /* 原卷宗已经删掉了，文件是从旧文件夹里并过来的：标一句，免得看着像放错了地方 */
            file.origin ? h('span', { key: 'o', className: 'dz-doc-origin', title: `原文件夹：${file.origin}` }, '旧卷宗') : null,
            h('span', { key: 'm', className: 'dz-doc-meta' }, `${kbOf(file)} · ${relTime(file.mtime)}`),
            h('span', { key: 't', className: 'dz-doc-tools' }, [
              h('button', { key: 'n', className: 'dz-mini', title: '用这份交接文档开一个新对话', onClick: () => startChatWithDocs([file.path]) }, glyph('chat')),
              h('button', { key: 'e', className: 'dz-mini', title: '导出到指定文件夹', onClick: () => exportDocs([file.path]) }, glyph('export')),
              h('button', { key: 'd', className: 'dz-mini is-danger', title: '删除这份文档', onClick: () => deleteDocs([file.path]) }, glyph('del')),
              h('button', { key: 'l', className: 'dz-mini', title: '定位到生成它的对话', onClick: () => locateDoc(file) }, glyph('locate')),
            ]),
          ])
        }

        const groupBlock = (group, key, label, opts) => {
          const open = docOpen === key
          const files = (group && group.files) || []
          const sub = Boolean(opts && opts.sub)
          const targets = docPicked.length ? docPicked.filter((path) => files.some((file) => file.path === path)) : groupFiles(group)
          return h('div', { key: `g-${key}`, className: `dz-doc-group${open ? ' is-open' : ''}` }, [
            h(
              'div',
              {
                key: 'h',
                className: `dz-doc-head${sub ? ' is-sub' : ''}`,
                title: sub ? '没有归入任何卷宗的交接文档（含已删除卷宗留下来的）' : `卷宗「${label}」的交接文档`,
                onClick: () => {
                  setDocOpen(open ? '' : key)
                  setDocPicking(false)
                  setDocPicked([])
                  setDocNote('')
                },
              },
              [
                h('span', { key: 'c', className: 'dz-doc-caret' }, open ? '▾' : '▸'),
                h('span', { key: 'i', className: 'dz-doc-ico' }, glyph(sub ? 'doc' : 'folder')),
                h('span', { key: 'n', className: 'dz-doc-title' }, label),
                h('span', { key: 'k', className: 'dz-doc-count' }, files.length ? `${files.length} 份` : '空'),
                open && files.length
                  ? h('span', { key: 'a', className: 'dz-doc-batch' }, [
                      h('button', {
                        key: 's',
                        className: `dz-mini${docPicking ? ' is-on' : ''}`,
                        title: '逐份勾选',
                        onClick: (event) => {
                          event.stopPropagation()
                          setDocPicking(!docPicking)
                          setDocPicked([])
                        },
                      }, glyph('check')),
                      h('button', {
                        key: 'n',
                        className: 'dz-mini',
                        title: docPicked.length ? `用选中的 ${docPicked.length} 份开新对话` : `用这 ${files.length} 份开新对话`,
                        onClick: (event) => {
                          event.stopPropagation()
                          startChatWithDocs(targets)
                        },
                      }, glyph('chat')),
                      h('button', {
                        key: 'e',
                        className: 'dz-mini',
                        title: docPicked.length ? `导出选中的 ${docPicked.length} 份` : `导出全部 ${files.length} 份`,
                        onClick: (event) => {
                          event.stopPropagation()
                          exportDocs(targets)
                        },
                      }, glyph('export')),
                      h('button', {
                        key: 'd',
                        className: 'dz-mini is-danger',
                        title: docPicked.length ? `删除选中的 ${docPicked.length} 份` : `删除全部 ${files.length} 份`,
                        onClick: (event) => {
                          event.stopPropagation()
                          deleteDocs(targets)
                        },
                      }, glyph('del')),
                    ])
                  : null,
              ],
            ),
            open && files.length
              ? h('div', { key: 'b', className: 'dz-doc-body' }, files.map((file, index) => docRow(file, `f-${key}-${index}`)))
              : null,
            open && !files.length ? h('div', { key: 'e', className: 'dz-doc-empty' }, '这个文件夹里还没有交接文档。') : null,
          ])
        }

        const groups = []
        if (docs) {
          if (sel.kind === 'docLoose') {
            /* 未归档的交接文档：没有卷宗这一层，直接列文档 */
            if (docView.loose.length) {
              const loosePicked = docPicked.filter((path) => docView.loose.some((file) => file.path === path))
              groups.push(
                h('div', { key: 'loose', className: 'dz-doc-group is-open' }, [
                  loosePicked.length
                    ? h('div', { key: 'bt', className: 'dz-doc-head is-strip' }, [
                        h('span', { key: 'n', className: 'dz-doc-title' }, `已勾选 ${loosePicked.length} 份`),
                        h('span', { key: 'a', className: 'dz-doc-batch' }, [
                          h('button', {
                            key: 'n',
                            className: 'dz-mini',
                            title: `用勾选的 ${loosePicked.length} 份开新对话`,
                            onClick: () => startChatWithDocs(loosePicked),
                          }, glyph('chat')),
                          h('button', {
                            key: 'e',
                            className: 'dz-mini',
                            title: `导出勾选的 ${loosePicked.length} 份`,
                            onClick: () => exportDocs(loosePicked),
                          }, glyph('export')),
                          h('button', {
                            key: 'd',
                            className: 'dz-mini is-danger',
                            title: `删除勾选的 ${loosePicked.length} 份`,
                            onClick: () => deleteDocs(loosePicked),
                          }, glyph('del')),
                        ]),
                      ])
                    : null,
                  h(
                    'div',
                    { key: 'b', className: 'dz-doc-body' },
                    docView.loose.map((file, index) => docRow(file, `l-${index}`)),
                  ),
                ]),
              )
            }
          } else {
            for (const folder of docView.folders) groups.push(groupBlock(folder, folder.key, folder.name))
          }
        }
        docsList = docsError
          ? h('div', { className: 'dz-err' }, docsError)
          : docs
            ? groups.length
              ? h('div', { key: 'docs', className: 'dz-list' }, [
                  ...groups,
                  docNote ? h('div', { key: 'note', className: 'dz-doc-note' }, docNote) : null,
                ])
              : sel.kind === 'docLoose'
                ? h('div', { key: 'none', className: 'dz-empty' }, [
                    h('div', { key: 'a' }, '没有未归档的交接文档。'),
                    h('div', { key: 'b' }, '没归入卷宗的、以及卷宗被删掉后留下的文档，都会收到这里。'),
                  ])
                : h('div', { key: 'none', className: 'dz-empty' }, [
                    h('div', { key: 'a' }, '还没有交接文档。'),
                    h('div', { key: 'b' }, '在对话里点左下角「交接」，生成的文档会出现在这里。'),
                  ])
            : h('div', { key: 'loading', className: 'dz-empty' }, '读取中…')
      } else if (!rows.length) {
        const text = inFoldersView
          ? ['还没有卷宗。', '用左下的「＋ 新建卷宗」建第一个。']
          : sel.kind === 'folder'
            ? ['这个卷宗还是空的。', '到「未归档」或「全部对话」里点右上「选择」，勾选后「归入…」到这里。']
            : sel.kind === 'all'
              ? ['还没有任何对话。']
              : ['没有未归档的对话。', '所有对话都已分卷。']
        empty = h(
          'div',
          { className: 'dz-empty' },
          text.map((line, index) => h('div', { key: index }, line)),
        )
      }

      const main = h('section', { className: 'dz-main' }, [
        h('div', { key: 'head', className: 'dz-main-head' }, [
          h('div', { key: 'titles' }, [
            h('div', { key: 't', className: 'dz-main-title' }, mainTitle),
            h('div', { key: 's', className: 'dz-main-sub' }, mainSub),
          ]),
          h('div', { key: 'acts', className: 'dz-head-actions' }, [
            busy ? h('span', { key: 'busy', className: 'dz-main-sub' }, '处理中…') : null,
            ...headActions,
          ]),
        ]),
        error ? h('div', { key: 'err', className: 'dz-err' }, error) : null,
        docsList ||
          empty ||
          h(
            'div',
            { key: 'list', className: `dz-list${view === 'grid' ? ' is-grid' : ''}${picking ? ' is-picking' : ''}` },
            rows,
          ),
      ])

      /* 归入哪一卷宗：右上角的小浮层，而不是每行一个下拉 */
      const moving = picked.filter((id) => entryOf[id]).length
      const assignMenu = assignOpen
        ? h('div', { key: 'assign', className: 'dz-overlay is-menu', onClick: () => setMenuShake((tick) => tick + 1) }, [
            h(
              'div',
              {
                key: `box-${menuShake}`,
                className: `dz-menu${menuShake ? ' is-shake' : ''}`,
                onClick: (event) => {
                  event.stopPropagation()
                },
              },
              [
                h('div', { key: 'h', className: 'dz-menu-head' }, `把 ${picked.length} 个对话归入…`),
                moving
                  ? h(
                      'div',
                      { key: 'w', className: 'dz-menu-warn' },
                      `其中 ${moving} 个已经在卷宗里，会被移到你选的那个卷宗`,
                    )
                  : null,
                ...folders.map((item) => {
                  const count = dossier.entries.filter((entry) => entry.folderId === item.id).length
                  return h(
                    'button',
                    { key: item.id, className: 'dz-menu-item', onClick: () => assignMany(item.id) },
                    [
                      h('span', { key: 'i', className: 'dz-menu-ico' }, glyph('folder')),
                      h('span', { key: 'n', className: 'dz-menu-name' }, item.name),
                      h('span', { key: 'c', className: 'dz-menu-count' }, String(count)),
                    ],
                  )
                }),
                folders.length
                  ? null
                  : h('div', { key: 'none', className: 'dz-menu-empty' }, '还没有卷宗，下面可以直接建一个。'),
                h('div', { key: 'sep', className: 'dz-menu-sep' }),
                creatingInMenu
                  ? h('div', { key: 'newrow', className: 'dz-menu-newrow' }, [
                      h('input', {
                        key: 'i',
                        className: 'dz-input',
                        autoFocus: true,
                        placeholder: '新卷宗名，回车保存',
                        value: assignNew,
                        onChange: (event) => setAssignNew(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') createFolderInMenu()
                          if (event.key === 'Escape') {
                            setCreatingInMenu(false)
                            setAssignNew('')
                          }
                        },
                      }),
                      h(
                        'button',
                        { key: 'ok', className: 'dz-btn is-primary', disabled: Boolean(busy) || !assignNew.trim(), onClick: createFolderInMenu },
                        '保存',
                      ),
                      h(
                        'button',
                        {
                          key: 'c',
                          className: 'dz-btn',
                          onClick: () => {
                            setCreatingInMenu(false)
                            setAssignNew('')
                          },
                        },
                        '取消',
                      ),
                    ])
                  : h(
                      'button',
                      {
                        key: 'add',
                        className: 'dz-menu-item is-add',
                        onClick: () => {
                          setCreatingInMenu(true)
                          setAssignNew('')
                        },
                      },
                      [
                        h('span', { key: 'i', className: 'dz-menu-ico dz-menu-plus' }, '＋'),
                        h('span', { key: 'n', className: 'dz-menu-name' }, '新建卷宗'),
                      ],
                    ),
                h('div', { key: 'sep2', className: 'dz-menu-sep' }),
                h(
                  'button',
                  { key: 'cancel', className: 'dz-menu-item is-cancel', onClick: () => setAssignOpen(false) },
                  '取消',
                ),
              ],
            ),
          ])
        : null

      /* 「这条对话有好几份交接文档」时的清单：挑一份跳到它 */
      const hoList = hoMenu ? handoffDocsOf(hoMenu) : []
      const hoPanel = hoMenu
        ? h('div', { key: 'homenu', className: 'dz-overlay is-menu', onClick: () => setMenuShake((tick) => tick + 1) }, [
            h(
              'div',
              {
                key: `box-${menuShake}`,
                className: `dz-menu${menuShake ? ' is-shake' : ''}`,
                onClick: (event) => {
                  event.stopPropagation()
                },
              },
              [
                h('div', { key: 'h', className: 'dz-menu-head' }, `「${titleOf(hoMenu)}」的交接文档：挑一份打开`),
                ...hoList.map((file) =>
                  h(
                    'button',
                    {
                      key: file.path,
                      className: 'dz-menu-item',
                      title: file.path,
                      onClick: () => {
                        setHoMenu('')
                        jumpToDoc(file.path)
                      },
                    },
                    [
                      h('span', { key: 'i', className: 'dz-menu-ico' }, glyph('doc')),
                      h('span', { key: 'n', className: 'dz-menu-name' }, file.name),
                      h('span', { key: 'c', className: 'dz-menu-count' }, `${Math.max(1, Math.round(file.size / 1024))} KB`),
                    ],
                  ),
                ),
                hoList.length ? null : h('div', { key: 'none', className: 'dz-menu-empty' }, '还没读到它的交接文档，稍后再点一次。'),
              ],
            ),
          ])
        : null
      const confirmBox = confirmAsk
        ? h(
            'div',
            {
              key: 'confirm',
              className: 'dz-overlay',
              /* 点空白不关窗，只让框抖一下：跟系统模态框一样，必须明确选一个 */
              onClick: () => setDialogShake((tick) => tick + 1),
            },
            [
              h(
                'div',
                {
                  key: `box-${dialogShake}`,
                  className: `dz-dialog${dialogShake ? ' is-shake' : ''}`,
                  onClick: (event) => {
                    event.stopPropagation()
                  },
                },
                [
                  h('div', { key: 't', className: 'dz-dialog-title' }, confirmAsk.title),
                  ...confirmAsk.lines.map((line, index) => h('div', { key: `l${index}`, className: 'dz-dialog-line' }, line)),
                  h('div', { key: 'hint', className: 'dz-dialog-hint' }, '点空白处不会关掉：按 Esc，或选下面一个按钮。'),
                  h('div', { key: 'a', className: 'dz-dialog-actions' }, [
                    h('button', { key: 'c', className: 'dz-btn', onClick: () => setConfirmAsk(null) }, '取消'),
                    h(
                      'button',
                      {
                        key: 'ok',
                        className: `dz-btn ${confirmAsk.danger ? 'is-danger-soft' : 'is-primary'}`,
                        onClick: () => {
                          const run = confirmAsk.onOk
                          setConfirmAsk(null)
                          if (run) run()
                        },
                      },
                      confirmAsk.okLabel,
                    ),
                  ]),
                ],
              ),
            ],
          )
        : null

      const u = usage.sessionId === newestId && usage.data && usage.data.live ? usage.data : null
      const usageBits = []
      if (u) {
        const scale = u.steps ? `${u.steps} 步` : u.turns ? `${u.turns} 轮` : ''
        if (scale) usageBits.push(`最近一个对话 ${scale}${u.userMessages ? `（${u.userMessages} 条消息）` : ''}`)
        if (u.contextTokens) {
          const window = u.contextWindow ? ` / ${shortNum(u.contextWindow)}` : ''
          const percent = u.contextWindow ? `（${Math.round((u.contextTokens / u.contextWindow) * 100)}%）` : ''
          usageBits.push(`上下文 ${shortNum(u.contextTokens)}${window}${percent}`)
        }
        if (u.lastCost !== null && u.lastCost !== undefined) {
          const hit = u.lastTotal ? `，命中 ${u.lastHitRate}%` : ''
          usageBits.push(`上一轮 ${money(u.lastCost)}${hit}`)
        }
      } else if (newestId) {
        usageBits.push(usage.phase === 'error' ? '用量读取失败' : '用量读取中…')
      }

      /* 选中某条对话时的第二行：这条对话多大、冷启动要多少钱、缓存还在不在 */
      const selLine = focused
        ? (() => {
            const data = selUse.id === focused && selUse.phase === 'ready' ? selUse.data : null
            const meta = byId[focused] || {}
            const parts = [`已选「${titleOf(focused)}」`]
            if (!data || !data.ok) {
              parts.push(selUse.phase === 'error' ? '用量读取失败' : '用量读取中…')
              return h('div', { key: 'sel', className: 'dz-usage is-sel' }, parts.join(' · '))
            }
            if (data.steps) parts.push(`${data.steps} 步${data.userMessages ? `（${data.userMessages} 条消息）` : ''}`)
            if (data.contextTokens) {
              parts.push(`上下文 ${shortNum(data.contextTokens)}`)
              const missPrice = data.band === 'peak' ? 2 : 1
              parts.push(`冷启动约 ${money((data.contextTokens * missPrice) / 1_000_000)}`)
            }
            const at = Number(data.at) || 0
            const warm = Boolean(meta.running) || (at > 0 && Date.now() - at < 60 * 60 * 1000)
            return h('div', { key: 'sel', className: 'dz-usage is-sel' }, [
              h('span', { key: 't' }, parts.join(' · ')),
              h(
                'span',
                {
                  key: 's',
                  className: `dz-state${warm ? ' is-warm' : ' is-broken'}`,
                  title: warm
                    ? '一小时内有过往来，前缀缓存大概率还在，接着聊很便宜'
                    : '一小时以上没有来往，下次开口要把整段上下文重新算一遍',
                },
                [h('span', { key: 'd', className: 'dz-dot' }), warm ? '对话中' : '已断'],
              ),
            ])
          })()
        : null

      return h('div', { className: 'dz-page' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { key: 'top', className: 'dz-top' }, [
          h('h1', { key: 'h', className: 'dz-h1' }, [
            h('span', { key: 'x' }, '卷宗'),
            h('small', { key: 's' }, `${visible.length} 个对话 · ${folders.length} 个卷宗`),
          ]),
          h('div', { key: 'u', className: 'dz-usage' }, usageBits.join(' · ')),
          selLine,
          h('div', { key: 'sub', className: 'dz-sub' }, [
            h('span', { key: 'a' }, '交接文档目录 '),
            h('code', { key: 'b' }, dossier.paths.handoffRoot || '—'),
            h('span', { key: 'c' }, ' · 备份 '),
            h('code', { key: 'd' }, dossier.paths.backupRoot || '—'),
          ]),
        ]),
        h('div', { key: 'body', className: 'dz-body' }, [
          h('aside', { key: 'side', className: 'dz-side' }, sideChildren),
          main,
        ]),
        assignMenu,
        hoPanel,
        confirmBox,
        /* 导入用的文件选择器：藏起来，由「导入」按钮代点 */
        h('input', {
          key: 'bundle',
          ref: bundleInput,
          type: 'file',
          accept: '.json,application/json',
          style: { display: 'none' },
          onChange: onBundlePicked,
        }),
      ])
    }

    /* ------------------------------------------------- 对话框里的交接按钮 */

    /* 面板兜底：任何渲染异常都显示成红色提示，而不是整片空白 */

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[dossier] 面板渲染失败', error, info)
        }
      }

      render() {
        if (this.state.error) {
          const message = (this.state.error && this.state.error.message) || String(this.state.error)
          return h('div', { className: 'dz-page' }, [
            h('style', { key: 'css' }, CSS),
            h('div', { key: 't', className: 'dz-h1' }, '卷宗面板出错了'),
            h('div', { key: 'e', className: 'dz-err' }, message),
            h('div', { key: 'h', className: 'dz-sub' }, '把这段文字发给 DeepSeek 会话即可定位。'),
          ])
        }
        return this.props.children
      }
    }

    function DossierPanel(props) {
      return h(PanelBoundary, null, h(DossierPage, props))
    }

    function HandoffButton(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [status, setStatus] = React.useState('idle')
      const [hint, setHint] = React.useState('')

      React.useEffect(() => {
        if (status === 'idle') return undefined
        const timer = setTimeout(() => {
          setStatus('idle')
          setHint('')
        }, 6000)
        return () => clearTimeout(timer)
      }, [status])

      async function onClick(event) {
        event.preventDefault()
        event.stopPropagation()
        if (!sessionId || status === 'sending') return
        setStatus('sending')
        setHint('')
        try {
          await postJson(`${BASE}/handoff`, { sessionId })
          setStatus('ok')
        } catch (err) {
          const code = err && err.code ? String(err.code) : ''
          setStatus(code === 'empty-session' ? 'empty' : 'error')
          setHint(messageOf(err))
        }
      }

      const label =
        status === 'sending'
          ? '生成中…'
          : status === 'ok'
            ? '已生成'
            : status === 'empty'
              ? '无可交接'
              : status === 'error'
                ? '重试'
                : '交接'
      const title =
        status === 'error'
          ? hint || '交接请求失败'
          : status === 'empty'
            ? hint || '这条对话还没有可交接的内容'
            : '生成本次交接文档：会往当前对话发一条短消息让它写，费用约等于一次普通轮次；文档写进项目 goals/ 并自动备份'
      const tone =
        status === 'sending' ? ' is-busy' : status === 'ok' ? ' is-ok' : status === 'error' || status === 'empty' ? ' is-err' : ''

      return h(
        'button',
        {
          className: `dz-hb${tone}`,
          onClick,
          disabled: status === 'sending' || !sessionId,
          title,
          type: 'button',
        },
        [
          h('span', { key: 'i', className: 'dz-hb-ico' }, glyph('doc')),
          h('span', { key: 't', className: 'dz-hb-text' }, label),
        ],
      )
    }

    function HandoffSlot(props) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center' } }, [
        h('style', { key: 'css' }, CSS),
        h(HandoffButton, { key: 'b', ...props }),
      ])
    }

    /* --------------------------------------------------------------- 装配 */

    return {
      // Cordis 里访问 ctx.<服务> 前必须声明注入，否则读属性时直接抛
      // 「cannot get property "sessions" without inject」
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        ctxRef = ctx

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_KEY, label: () => '卷宗' },
            DossierPanel,
          ),
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 20, label: () => '卷宗' },
            DossierIcon,
          ),
        )

        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: 'dossier-handoff', order: 40 }, HandoffSlot),
        )
      },
    }
  },
})
