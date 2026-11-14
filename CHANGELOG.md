# 更新日志

## 1.0.1（2026-11-14）

只修显示，不动数据与接口。两类缺陷同一个病根：**容器用 vh 硬算高度、flex 子项没禁收缩，于是「装不下」被表现成「撑破」而不是「滚动」**。

- **对话页标记溢出卡片**：卡片里「已交接 N 次」+「已在卷宗『…』里」两枚标记是 `white-space:nowrap` 的 flex 子项，没有 `min-width:0`，最小内容宽度把整行撑得比卡片宽；而卡片本身 `overflow:visible`，溢出就直接画到隔壁卡片上。改法：`.dz-row-tags` 加 `min-width:0; overflow:hidden; flex-wrap:nowrap`，`.dz-tag` 加 `min-width:0; max-width:100%`，标记文字单独用 `.dz-tag-name` 走省略号；完整名字仍在按钮 `title` 里，悬停可看。
- **左栏不滚、一直向下延伸**：`.dz-side-scroll` 是 flex 列，卷宗行只有 `height:32px` 却默认 `flex-shrink:1`，行数一多行先被压扁（32px → 23px）而不是溢出，所以永远「没有滚动条」；外面那层还用 `position:sticky; max-height:calc(100vh - 128px)` 硬算，跟标题栏实际高度无关，底边压到窗口沿。改法：`.dz-side-scroll > * { flex:0 0 auto }` 禁掉收缩，`.dz-side` 去掉 sticky 与 vh 上限、改 `box-sizing:border-box; max-height:100%; overflow:hidden`，`.dz-page` 收成 `height:100%; overflow:hidden`，由 `.dz-body` 的 `flex:1; min-height:0` 把剩余高度分给左右两栏。同一个坑在外层还有一次——左栏自己也是 flex 列，顶部那几行（交接文档 / 未归档 / 全部对话）在内容超高时会被压到 22px，所以补 `.dz-side > * { flex:0 0 auto }`，只让 `.dz-side-scroll` 继续 `flex:1 1 auto` 去吃掉剩余高度。
- **同类位置一并收口**：`.dz-main` 的 `max-height:calc(100vh - 196px)` 改 `max-height:100%`，对话列表 `.dz-list` 补 `flex:1; min-height:0; overflow-y:auto`（列表再长也只在自己的框里滚）；交接目录那行长路径 `.dz-sub` 允许 `overflow-wrap:anywhere`；`.dz-row-hint` 走省略号；滚动条统一 10px 细条（`::-webkit-scrollbar` + thumb 圆角、track 透明），并给滚动区加 `scrollbar-gutter:stable` 免得出现/消失时内容横跳。
- **交接标记去掉右箭头**：「已交接 N 次」后面原本跟一个 `→`（有多份交接文档时是 `▾`）。单份时那个箭头只是占宽度、还容易被误读成「点了没反应」，去掉；多份时保留 `▾`，提示点开是清单。
- **测试**：`client-smoke` 63 → 73 项，新增 10 项盯住这次的问题——行不压扁、不再有 vh 硬算、页面由父容器定高、列表自滚、标记行不换行、超长名两处都接上省略号、标记不超卡片宽、左栏不是 sticky、左栏算上 padding 也不超父容器、交接标记不再挂右箭头。
- **验证**：1344×894 与 1180×720 两个视口、21 / 4 个卷宗三组用例，改前左栏卷宗行被压到 23px、卡片标记最多顶出 76px，改后行高恢复 32px、滚动区 `scrollHeight 746 > clientHeight 473`、越界标记 0 个。

## 1.0.0（2026-11-07）

这一版把交接从「能生成」推到「能验收」，并把界面收干净。行为变化：

- **空对话拒绝**：`POST /dsh-dossier/handoff` 先看会话事件流，没有任何 `user/message`、`assistant/message`、`turn/end`、`step/start` 就返回 `409`、`code: "empty-session"`，**不投递 prompt**。以前在空会话点交接会白跑一轮最贵的冷启动。
- **按钮即时反馈**：客户端保留服务端 `code`，空对话当场显示「无可交接」，6 秒后复位为「交接」；生成中文字为绿，完成后回到正文色。
- **交接文档体检** `scripts/handoff-eval.mjs`（23 项）：骨架八节齐全、≤1500 token、无代码块与超长行、反引号路径必须存在、`已否决` 必须是「做法 → 症状 → 结论」三段式、下一步必须带验收标准、密钥与内网地址干净。有硬伤时退出码 1，可进 CI。
- **交接文档骨架收紧**：新增术语表、仓库根与 git 基线、三条脚本跑法、阶段号规则，并把「单测通过 ≠ 线上生效」写成单独一条——零上下文的新会话因此不必再猜。
- **交接按钮精简**：去掉「交接文档」小字，只留图标与「交接」。
- **图标整套重画**：13 个图标统一 16 网格、1.5 描边、圆头圆角；侧栏入口换成档案盒。
- **测试**：`selftest` 218 项、`client-smoke` 63 项、文档体检 23 项。

破坏性变化：无。`~/.dsh/dossier.json` 格式不变，`goals/` 下已有文档照常读取。

## 0.1.0-beta.1（2026-11-06）

首个公开版本：卷宗面板（归卷、排序、置顶、多选）、交接文档目录（导出 / 删除 / 定位 / 整包导入导出）、`dossier_handoff_write` 一键交接、成本与上下文可见。
