<p align="center"><img src="docs/assets/logo.svg" alt="Tukey logo" width="96" height="96" /></p>
<h1 align="center">Tukey</h1>

<p align="center"><b>The open-source Julius AI alternative — inside your coding agent.</b><br/>
Attach a CSV or a Postgres database. Tukey profiles it, answers in SQL, and draws real charts in the conversation.</p>

<p align="center"><sub>Named for John Tukey, who invented exploratory data analysis, the box plot, and the 1.5×IQR outlier rule this profiler runs.</sub></p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat" /></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-74%20passing-brightgreen?style=flat" />
  <img alt="runtime" src="https://img.shields.io/badge/DuckDB-in--process-fff100?style=flat" />
  <img alt="charts" src="https://img.shields.io/badge/charts-Vega--Lite-4c78a8?style=flat" />
</p>

<p align="center">English · <a href="README.zh.md">中文</a></p>

A real DeepSeek Harness session — the agent attached a CSV, profiled it, and drew
these charts as conversation nodes (headless-Chrome capture of the live UI; see
[the verification record](docs/VERIFICATION.md)):

<p align="center">
  <img src="docs/assets/conversation-full.png" alt="Full DeepSeek Harness window: a heatmap and a boxplot rendered inside the conversation, with the session sidebar and composer visible" width="100%" />
</p>

> Status: **M1 + M2 + M3 complete.** The dsh plugin is live-verified inside
> `dsh web 0.1.0-rc.8` — the full attach → profile → query → chart chain ran in
> a real session and both charts rendered as conversation nodes
> ([verification record](docs/VERIFICATION.md)). The MCP server passes
> protocol-level tests plus a stdio smoke. See [Known limitations](#known-limitations).

---

## What it does

```
data_attach     →  register a CSV / Parquet / JSON / XLSX file as a queryable table
data_attach_db  →  attach PostgreSQL / MySQL / SQLite read-only and list its tables
data_profile    →  types, missing values, exact distinct counts, outliers, quality issues, chart ideas
data_query      →  one read-only SQL statement, results as lossless JSON
data_chart      →  bar / line / scatter / histogram / area / heatmap / boxplot (Vega-Lite,
                   interactive) + sankey / sunburst / treemap / gauge (ECharts) — with color
                   series, stacked/grouped layout, facet small multiples; line & scatter pan/zoom
data_report     →  a self-contained HTML report (profile + charts as inline SVG); prints to PDF
data_sources    →  what is currently attached
```

The same five tools ship on two hosts from one engine:

| Host | Package | Chart delivery |
|---|---|---|
| DeepSeek Harness plugin | `tukey` | live conversation node (Vega canvas) |
| MCP server (Claude Code / Codex / Cursor / any MCP client) | `tukey-mcp-server` | SVG file + full Vega-Lite spec in `structuredContent` |

Every tool is also reachable from Code Mode as `await tools.data_*(args)`, so
the agent can chain the whole analysis inside one program instead of spending a
round trip per step.

The **workbench** — a session-header panel listing this session's data
sources, a chart gallery with click-to-scroll, and generated reports:

<p align="center">
  <img src="docs/assets/workbench-panel.png" alt="The Tukey workbench panel open over a dsh conversation: data sources, chart gallery with locate buttons, and the report archive" width="100%" />
</p>

Both engines in one conversation — heatmap and boxplot drawn live by Vega-Lite,
sankey and treemap rendered on the host by ECharts:

<p align="center">
  <img src="docs/assets/chart-echarts.png" alt="A dsh conversation showing a Vega-Lite heatmap and boxplot alongside an ECharts sankey and treemap" width="100%" />
</p>

More in-conversation chart kinds (same theme, exported from a live session):

<p align="center">
  <img src="docs/assets/chart-heatmap.png" alt="Heatmap: revenue by region and product" width="32%" />
  <img src="docs/assets/chart-boxplot.png" alt="Boxplot: revenue distribution and outliers per region" width="32%" />
  <img src="docs/assets/chart-grouped-bar.png" alt="Grouped bars: revenue per region split by product" width="32%" />
</p>

## Install

DeepSeek Harness:

```bash
dsh plugin --profile web add tukey
```

Claude Code (or any MCP client, via stdio):

```bash
claude mcp add tukey -- npx -y tukey-mcp-server
```

## Architecture

Three decisions shape the codebase.

**The engine knows nothing about the harness.** `@tukey/core` takes paths
and SQL and returns lossless JSON. It imports no dsh, MCP, or CLI type. That is
what lets the same analysis ship to Claude Code, Codex, and Cursor through an
MCP adapter later without a second implementation — the single largest factor
in whether a plugin reaches an audience beyond one host.

**DuckDB does the statistics.** `SUMMARIZE` returns min/max/avg/std/quartiles/
approx_unique/null_percentage for every column in one pass, and reads CSV,
Parquet and JSON directly with full-file type inference. Only IQR outliers,
duplicate-row detection, and the judgement about what is worth flagging are
written by hand.

**Two chart engines, chosen per kind — and the client bundles one.** Vega-Lite
owns the exploratory kinds: its grammar keeps the spec short and the browser
half renders it live and interactive. ECharts covers the shapes Vega-Lite has
no grammar for at all — flow (sankey), hierarchy (sunburst, treemap), and a
single-value KPI (gauge). Bundling ECharts in the browser too would add ~600 kB
to a single-file plugin bundle every session downloads, chart or not, so those
kinds are rendered to SVG on the host and travel as markup inside the event;
the spec rides along, so a client that does speak ECharts can render it live.
Measured cost to the browser bundle: **0 kB**.

**Charts are specs carried on session events.** The harness tool-card
kinds are a closed set — `generic`, `terminal`, `diff`, `search`, `web` — with
no chart member, so a tool result can only ever degrade a chart to text. A real
chart has to come from a *conversation node*, which the client half registers.

That constraint turned out to pick the chart format too. A conversation node
must rebuild its view as a **pure function of durable events** — no clock, no
random, no live state — and the engine prefers whole-value checkpoints over
deltas. A Vega-Lite spec with its data inlined is exactly that: one plain JSON
value that replays byte-for-byte. Vega-Lite was chosen because it satisfies the
replay rule, not because it is a popular chart library.

```
@tukey/core            engine, profiling, DB connectors, chart specs  (host-agnostic)
  ├── @tukey/report    Vega-Lite -> SVG (pure JS) + self-contained HTML reports
  ├── tukey            dsh host half: 7 tools + chart event
  │     └── ./client         dsh browser half: conversation node + Vega canvas
  └── tukey-mcp-server stdio MCP server: same 7 tools, charts as SVG files
```

## Development

```bash
pnpm install
pnpm -r run build
pnpm -r run test
```

89 tests: 58 over the core (SQL policy, JSON conversion, profiling with exact
distinct counts, charts, and live PostgreSQL/MySQL connector tests that
auto-skip without the Docker fixtures), 5 over the report builder, 14 driving
the real dsh plugin tools end to end against DuckDB (including per-agent
isolation), and 9 protocol-level MCP tests over the SDK's in-memory transport
(plus a scripted stdio smoke). Live verification against a running `dsh web` is scripted in
`scripts/mock-llm-scripted.mjs` + `scripts/verify-live.patch.yml` — see
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Known limitations

These are real and worth reading before building on this.

- **PTC 模式 (Code Mode) presets reject direct tool calls** — the model must
  wrap them in a `run_code` program there. Under the Standard preset the tools
  are called directly. Verified behavior, documented in
  [docs/VERIFICATION.md](docs/VERIFICATION.md).
- **dsh per-agent engines are bounded, not lifecycle-tracked.** Each dsh agent
  session gets its own engine (no alias collisions), but the harness does not
  notify plugins on agent disposal, so the plugin holds at most 32 engines and
  evicts the least-recently used — that session transparently re-attaches on
  its next call.
- **The client bundle is ~860 kB.** Vega is inlined because the harness serves
  exactly one file per plugin and has no route for sibling chunks, so a
  chart-free session still pays for it.
- **`data_attach` takes any path the host process can read.** There is no
  workspace fencing yet; it inherits whatever the harness sandbox allows.
- **XLSX depends on DuckDB's `read_xlsx`**, which may need an extension
  download on first use. CSV, Parquet and JSON are covered by tests; XLSX is
  not.

## Notes on the dsh npm packages

Two things cost time here and are worth recording for anyone else building a
harness plugin:

- **`latest` points at a broken line.** `npm view @deepseek-ai/dsh-tools
  version` reports `0.0.1-rc.1`, but the current line is `0.1.0-rc.8`. Several
  `0.0.1-rc.1` packages cannot be installed at all —
  `@deepseek-ai/dsh-client-runtime@0.0.1-rc.1` depends on
  `@deepseek-ai/dsh-compact` and `@deepseek-ai/dsh-session@0.0.1-rc.1` depends
  on `@deepseek-ai/dsh-type-meta`; neither is published. Pin `0.1.0-rc.8`.
- **pnpm's `minimumReleaseAge` policy blocks the rc line** while it is fresh.
  This repo lifts it in `pnpm-workspace.yaml`, with a note to restore it once
  dsh has a stable release.

## Roadmap

| | |
|---|---|
| **M1** | Core + dsh plugin, charts in the conversation — done, live-verified |
| **M2** | MCP server: same capability in Claude Code / Codex / Cursor — done ← *you are here* |
| **M3** | HTML report export (prints to PDF), PostgreSQL / MySQL / SQLite, per-agent isolation — done |
| **M4** | Workbench panel: data sources, chart gallery with click-to-scroll, report archive — done, live-verified |

## License

MIT
