<h1 align="center">OpenAnalyst</h1>

<p align="center"><b>把你的编码 Agent 变成数据分析师。</b><br/>
接入一个 CSV，自动生成数据画像，用 SQL 提问，图表直接渲染在对话里。</p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat" /></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-55%20passing-brightgreen?style=flat" />
  <img alt="runtime" src="https://img.shields.io/badge/DuckDB-in--process-fff100?style=flat" />
  <img alt="charts" src="https://img.shields.io/badge/charts-Vega--Lite-4c78a8?style=flat" />
</p>

<p align="center"><a href="README.md">English</a> · 中文</p>

在真实 DeepSeek Harness 会话里渲染出来的图表（直接从会话导出——见[验证记录](docs/VERIFICATION.md)）：

<p align="center">
  <img src="docs/assets/chart-bar-region.png" alt="柱状图：各区域营收合计，在 dsh 对话中渲染" width="49%" />
  <img src="docs/assets/chart-line-trend.png" alt="折线图：营收随时间趋势，在 dsh 对话中渲染" width="49%" />
</p>

---

## 它能做什么

```
data_attach   →  把 CSV / Parquet / JSON / XLSX 文件注册为可查询的表
data_profile  →  类型、缺失值、精确基数、离群点、数据质量问题、图表建议
data_query    →  一条只读 SQL（DuckDB 方言），结果为无损 JSON
data_chart    →  在对话里画一张 Vega-Lite 图（dsh）/ 渲染为 SVG（MCP）
data_sources  →  当前已接入的数据集
```

同一个引擎，五个同名工具，服务两类宿主：

| 宿主 | 包名 | 图表交付方式 |
|---|---|---|
| DeepSeek Harness 插件 | `openanalyst` | 对话内实时渲染（conversation node + Vega canvas） |
| MCP server（Claude Code / Codex / Cursor / 任意 MCP 客户端） | `openanalyst-mcp-server` | SVG 文件 + `structuredContent` 里的完整 Vega-Lite spec |

在 dsh 的 Code Mode（PTC 模式）下，全部工具也可以在 `run_code` 程序里以
`await tools.data_*(args)` 链式调用，一段程序内完成 接入 → 画像 → 查询 → 出图。

## 安装

DeepSeek Harness：

```bash
dsh plugin --profile web add openanalyst
```

Claude Code（或任意 MCP 客户端，stdio）：

```bash
claude mcp add openanalyst -- npx -y openanalyst-mcp-server
```

## 架构

三个决定塑造了这套代码。

**引擎对宿主一无所知。** `@openanalyst/core` 输入路径和 SQL，输出无损 JSON，
不引用任何 dsh、MCP 或 CLI 类型。这是同一份分析能力能同时进入 dsh 和
Claude Code / Codex / Cursor、而不用维护第二套实现的根本原因。

**统计交给 DuckDB。** `SUMMARIZE` 一趟返回每列的
min/max/avg/std/四分位/基数/空值率，并直接读取 CSV、Parquet、JSON 且做全文件
类型推断。手写的只有 IQR 离群检测、重复行检测和"什么值得告警"的判断。
基数在 ≤200 万行时用精确计数——HyperLogLog 估计会把 4 个类目报成 3，
对分析工具这是错误答案，不是近似。

**图表是承载在会话事件上的 Vega-Lite spec。** dsh 的工具卡片种类是封闭集合
（`generic`、`terminal`、`diff`、`search`、`web`），没有图表成员，所以真正的图
只能来自 *conversation node*——由插件的浏览器半边注册。而 conversation node
要求视图是持久事件的**纯函数**（无时钟、无随机、无活状态），数据内联的
Vega-Lite spec 恰好就是可逐字节重放的一段纯 JSON。选 Vega-Lite 是因为它满足
重放规则，而不是因为它流行。

```
@openanalyst/core            引擎、画像、图表 spec        （宿主无关）
  ├── openanalyst            dsh 宿主半边：5 个工具 + 图表事件
  │     └── ./client         dsh 浏览器半边：conversation node + Vega canvas
  └── openanalyst-mcp-server stdio MCP server：同样 5 个工具，图表输出 SVG
```

## 开发

```bash
pnpm install
pnpm -r run build
pnpm -r run test
```

55 个测试：core 37 个（SQL 安全策略、JSON 转换、精确基数画像、图表），
dsh 插件 11 个（端到端驱动真实工具与 DuckDB），MCP 7 个（走 SDK 内存传输的
协议级往返，另有 stdio 进程冒烟脚本）。针对运行中 `dsh web` 的实机验证脚本在
`scripts/mock-llm-scripted.mjs` + `scripts/verify-live.patch.yml`——见
[docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 已知限制

- **PTC 模式（Code Mode）预设拒绝直接工具调用**——在该模式下模型需要把调用包进
  `run_code` 程序；标准模式下直接调用。已实测，记录在
  [docs/VERIFICATION.md](docs/VERIFICATION.md)。
- **dsh 插件的引擎是激活级单例，不是按 agent 隔离**。两个会话接入同名数据集会
  互相覆盖（MCP 是每客户端一进程，天然隔离）。按 agent 隔离排在 M3。
- **dsh 客户端 bundle 约 860 kB**。Vega 被内联，因为 harness 每个插件只服务一个
  文件、没有 sibling chunk 路由；无图会话也要付这份体积。
- **`data_attach` 接受宿主进程可读的任意路径**，尚无工作区围栏，继承 harness
  沙箱的边界。
- **XLSX 依赖 DuckDB 的 `read_xlsx`**，首次使用可能需要下载扩展。CSV、Parquet、
  JSON 有测试覆盖；XLSX 没有。

## 写给 dsh 插件开发者的备注

两件事在这里耗了时间，值得记录：

- **npm 的 `latest` 标签指向一条坏掉的旧版本线。** `npm view @deepseek-ai/dsh-tools
  version` 报 `0.0.1-rc.1`，但当前线是 `0.1.0-rc.8`。若干 `0.0.1-rc.1` 包完全装不上
  （依赖了未发布的 `dsh-compact`、`dsh-type-meta`）。锁定 `0.1.0-rc.8`。
- **浏览器半边不是 ESM。** dsh 的浏览器运行时是懒 CJS 模块表：插件 bundle 必须执行
  `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，react 等共享
  单例通过注入的 `require` 获取。裸 `import "react"` 会直接失败——页面没有
  import map。本仓库的 `packages/dsh/scripts/bundle-client.mjs` 复刻了官方
  `tsdown.client.ts` 的 banner/footer 契约。

## 路线图

| | |
|---|---|
| **M1** | Core + dsh 插件，对话内出图 — 已完成并实机验证 |
| **M2** | MCP server：同样能力进入 Claude Code / Codex / Cursor — 已完成 |
| **M3** | HTML / PDF 报告导出、PostgreSQL 与 MySQL、按 agent 隔离 |
| **M4** | 工作台面板：数据源、图表库、报告存档 |

## 许可证

MIT
