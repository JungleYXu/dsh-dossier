# dsh-dossier · 卷宗

**把长期项目切成「卷宗」，用一份交接文档替代重放上下文。**

[![npm](https://img.shields.io/npm/v/dsh-dossier?label=npm&color=blue)](https://www.npmjs.com/package/dsh-dossier)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![status](https://img.shields.io/badge/status-beta-orange)](#状态)
[![platform](https://img.shields.io/badge/DSH%20Desktop-0.2.x-5b6b8c)](https://www.deepseek.com/harness/)

DeepSeek Harness 插件：侧栏多一个「卷宗」面板，把会话按项目分卷归档；需要换人、换机器、或者隔了几天再回来时，让当前会话自己写一份交接文档，接手的会话读文档就能继续。

---

## 它解决什么问题

Agent 会话的费用不按轮数收，按**被重新计算的上下文长度**收。命中前缀缓存约 ¥0.02/M，未命中 ¥1–2/M —— 差 50 倍。真正贵的不是聊天，而是**冷启动**：重启 DSH、闲置一小时、或者换一台机器，几十万 token 要全量重算一次。

于是有三个常见做法，各有代价：

| 做法 | 问题 |
| --- | --- |
| 一条对话聊到底 | 每轮都在为越来越长的历史付费，冷启动一次几十元级 |
| fork 一条新对话 | fork 继承全部历史，第一次请求同样是全量未命中 |
| 把状态写进 `AGENTS.md` | 那是系统提示的一部分，一改，整个工作区的缓存全断 |

卷宗走第四条路：**把项目切成多条短对话（卷宗），用一份 800–1500 token 的交接文档传递状态**。新会话只读交接文档，不读旧对话。

---

## 核心能力

### 1. 卷宗面板

侧栏「卷宗」图标 → 整页面板。左栏即导航：**★ 交接文档**（置顶）→ 全部对话 → 未归档 → 卷宗分组 → 各卷宗。

- 每条对话**最多属于一个卷宗**；归入/移出都在面板里完成（「移到未归档」只退出卷宗，不删对话、不删文件）
- 排序三档：**☰ 默认（手动）** / **🕘 时间** / **AZ 名称**。时间和名称只影响检索，不改默认顺序；回到默认时手动顺序还在
- 默认顺序下可 ↑↓ 调位、可置顶；卷宗自身支持「按更新时间自动排序」开关
- 卡片 / 列表两种显示（卡片固定四行，行高不随内容跳动），选择记在浏览器本地
- 多选后「归入…」浮层里可直接新建卷宗；删除走插件自己的确认框，不用浏览器 `confirm`

### 2. 交接文档目录

交接文档就是工作区 `goals/` 下的 Markdown，面板直接列出来，不用开文件管理器。

- 每个卷宗在 `goals/` 下有同名子文件夹；没有卷宗的对话，文档落在 `goals/` 主目录（面板上归在「未归档」）
- 默认全部收起，一次展开一个；每份文档三个动作：**导出**（系统目录选择器，重名自动加 `-2`）、**删除**（备份仍在）、**定位**（跳回生成它的那条会话）
- 文件夹级支持逐份勾选 / 整组导出 / 整组删除
- **整包导出/导入**：一个 `dossier-handoff-<时间>.json` 带走全部文档（含卷宗归属），换机器导入；同名同内容跳过，同名不同内容另存 `-2`、`-3`，**绝不覆盖**
- 宿主只允许写 `goals/` 内的路径：先解析再比对前缀，`../` 与绝对路径越界一律拒绝

### 3. 一键交接（`dossier_handoff_write`）

对话框左下角「交接」按钮 → 给当前会话投递一条指令 → agent 调用 `dossier_handoff_write` 落盘：

```
<会话工作区>/goals/<卷宗名>/阶段-NN-<标题>.md
~/.dsh/dossier/handoffs/<工作区>/<时间>-<会话id>-阶段-NN-<标题>.md   # 全局备份
```

- 阶段号自动递增（扫同目录取 max+1）
- 双机场景下「对话在、文档不在」也能从全局备份取回
- 写盘前扫密钥与内网地址（`sk-…`、`password=`、`10./127./192.168./172.16-31.`、`PRIVATE KEY`），命中即告警
- 超过 1800 token 会提示「砍背景与过程」

文档骨架是固定的，写在工具描述里，agent 每次都会读到：

> 目标 / 当前状态 / 关键决策 / **已否决的方案** / 约束 / 涉及文件 / 下一步 / 未解决与风险

其中「已否决的方案」最容易被省略、代价也最高 —— 不写，接手的人会把否决过的路重走一遍。

### 4. 成本可见

面板顶部显示最近一条对话的规模：步数、消息条数、上下文长度、上一轮实际花费与缓存命中率（按 deepseek-flash 现价估算，空闲/高峰分档）。

点中某条对话后追加一行：

```
已选「标题」 · N 步（M 条消息） · 上下文 X · 冷启动约 ¥Y
```

- 「冷启动约 ¥Y」= 这段上下文整段未命中重算一次的价钱，也就是继续聊的**最坏**成本
- 状态「对话中」（绿）表示一小时内有过往来，前缀缓存还在；「已断」（橙）表示下次开口要重算整段
- 只按时间推断，不假装精确 —— 客户端没有「当前打开的是哪条会话」的接口

---

## 安装

```bash
# 插件市场里搜索「卷宗」，或：
dsh plugin install dsh-dossier
```

本地开发时改用链接方式：在 profile 的 `package.json` 里加 `"dsh-dossier": "link:/abs/path/to/dsh-dossier"`，把 `dsh-dossier` 加进 `dsh.profile.bundles`，在 profile 目录执行 `pnpm install`，重启 DSH。

## 配置

bundle patch 自带一行默认配置（row id `dossier`），可在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- insert:
    - id: dossier
      name: dsh-dossier
      config:
        handoffRoot: goals   # 交接文档根目录，相对会话工作区
```

## 数据放在哪

| 内容 | 位置 |
| --- | --- |
| 卷宗与归档元数据 | `~/.dsh/dossier.json` |
| 交接文档备份 | `~/.dsh/dossier/handoffs/<工作区>/` |
| 交接文档本体 | `<会话工作区>/goals/`（git 友好，可直接提交） |

全部本地，无网络请求。

## 状态

`0.1.0-beta`：功能完整、自测覆盖宿主与客户端两侧，但界面与数据结构仍可能调整。反馈请开 issue。

## 兼容性

- DSH Desktop 0.2.x（Web 客户端），宿主 Node ≥ 20
- 客户端注入 `@deepseek-ai/dsh-client-locale`、`-ui-slots`、`-ui-conversation`；只 `require('react')`，不依赖其它客户端包

## 开发

```bash
node scripts/selftest.mjs       # 191 项断言：纯函数 / 存储 / 写操作 / 交接落盘 / 文档目录 / 整包导入导出 / 费用估算 / 装配
node scripts/client-smoke.mjs   # 55 项断言：React 桩跑客户端，确认三个槽位都能渲染
node scripts/inspect-session.mjs <sessionId>   # 按 zstd 帧切会话日志，数事件类型（排查用）
```

自测通过 `DSH_DOSSIER_STORE`、`DSH_DOSSIER_BACKUP` 把数据改道到临时目录，跑完自清。

```
index.js   宿主侧：/dsh-dossier/{state,op,handoff,usage,docs,docop} 六条路由 + dossier_handoff_write 工具
client.js  客户端侧：main 面板 + sidebar.panellist 图标 + conversation.input.left 按钮
locale/    中英文显示名
scripts/   自测
```

改 `index.js` 要重启 DSH；只改 `client.js` 刷新页面（Ctrl+F5）即可。

## English summary

A DSH plugin that treats long-running projects as **volumes**: group sessions per project in a sidebar panel, and hand state to a fresh session through a generated handoff document instead of replaying context. Ships three surfaces — the volume panel, the `goals/`-backed handoff document browser (export / delete / jump-to-source, whole-bundle export & import), and a `dossier_handoff_write` tool with a fixed skeleton (goal / status / decisions / **rejected options** / constraints / files / next steps / risks). Also surfaces per-session context size and the cost of a cold restart.

## License

MIT © JungleYXu
